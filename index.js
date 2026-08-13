const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));

class ScrapingQueue {
    constructor(concurrencyLimit) {
        this.limit = concurrencyLimit;
        this.activeCount = 0;
        this.queue = [];
    }

    async enqueue(task, req) {
        let isCancelled = false;
        
        // Si el usuario cierra la pestaña o la plataforma corta la conexión, lo marcamos
        if (req) {
            req.on('close', () => {
                isCancelled = true;
            });
        }

        if (this.activeCount >= this.limit) {
            await new Promise(resolve => this.queue.push(resolve));
        }

        // Cuando llega su turno, verificamos si el usuario ya se fue
        if (isCancelled) {
            // Liberamos la fila para el siguiente inmediatamente
            if (this.queue.length > 0) {
                const nextResolve = this.queue.shift();
                nextResolve();
            }
            throw new Error('CLIENT_DISCONNECTED'); // Abortamos antes de gastar RAM
        }

        this.activeCount++;
        try {
            return await task();
        } finally {
            this.activeCount--;
            if (this.queue.length > 0) {
                const nextResolve = this.queue.shift();
                nextResolve();
            }
        }
    }
}

// Límite de 1 para evitar que el servidor se quede sin memoria RAM
const scrapingQueue = new ScrapingQueue(1);

// --- 1. ENDPOINT CURP ---
app.get('/scrape-curp', async (req, res) => {
    const curp = req.query.curp;
    if (!curp || curp.length !== 18) return res.status(400).json({ error: 'CURP inválido' });

    await scrapingQueue.enqueue(async () => {
        let browser;
        try {
            browser = await puppeteer.launch({ 
                headless: "new",
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox', 
                    '--disable-dev-shm-usage', 
                    '--disable-gpu', 
                    '--no-first-run', 
                    '--no-zygote', 
                    '--single-process', 
                    '--disable-extensions',
                    // --- MODO BAJO CONSUMO DE RAM ---
                    '--disable-background-networking',
                    '--disable-background-timer-throttling',
                    '--disable-client-side-phishing-detection',
                    '--disable-default-apps',
                    '--disable-hang-monitor',
                    '--disable-popup-blocking',
                    '--disable-prompt-on-repost',
                    '--disable-sync',
                    '--metrics-recording-only',
                    '--no-default-browser-check',
                    '--mute-audio',
                    '--disable-software-rasterizer'
                ]
            });
            const page = await browser.newPage();

            // OPTIMIZACIÓN 1: Rotar User-Agent aleatoriamente
            const userAgents = [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/113.0',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36'
            ];
            const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
            await page.setUserAgent(randomUA);

            // OPTIMIZACIÓN 2: Bloquear imágenes, CSS y fuentes para ahorrar memoria y tiempo
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                const resourceType = request.resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                    request.abort();
                } else {
                    request.continue();
                }
            });
            
                        const urlObjetivo = 'https://www.gob.mx/curp/'; 
            await page.goto(urlObjetivo, { waitUntil: 'networkidle2', timeout: 60000 });
            
            // --- INICIO DE CAMBIO QUIRÚRGICO ---
            // 1. Forzar el clic en la pestaña correcta ("Clave Única de Registro de Población")
            try {
                await page.waitForSelector('a[href="#tab-01"]', { visible: true, timeout: 5000 });
                await page.click('a[href="#tab-01"]');
                await new Promise(r => setTimeout(r, 1000)); // Breve pausa para la transición de la pestaña
            } catch (e) {
                console.log("Pestaña no encontrada por href, continuando el flujo...");
            }

            // 2. Selectores estrictos: Obligamos a Puppeteer a interactuar SOLO dentro de #tab-01
            const selectorInput = '#tab-01 input[name*="curp" i], #tab-01 input[id*="curp" i], #curpinput';
            const selectorBoton = '#tab-01 button[type="submit"], #searchButton';

            await page.waitForSelector(selectorInput, { visible: true, timeout: 20000 });
            
            // 3. Limpiar el campo (por si hay texto residual) y escribir la CURP
            const curpInput = await page.$(selectorInput);
            await curpInput.click({ clickCount: 3 });
            await curpInput.press('Backspace');
            await curpInput.type(curp); 
            
            // 4. Clic en el botón buscar específico de esa pestaña
            await page.click(selectorBoton); 
            
            // 5. Dar un segundo extra para que RENAPO procese y renderice la tabla
            await new Promise(r => setTimeout(r, 6000));
            // --- FIN DE CAMBIO QUIRÚRGICO ---


                        const datosExtraidos = await page.evaluate((curpBuscada) => {
                const bodyText = document.body.innerText.toUpperCase();
                
                // 1. Detección exacta del error oficial de RENAPO
                if (bodyText.includes('LOS DATOS INGRESADOS NO SON CORRECTOS') || 
                    bodyText.includes('EL FORMATO DEL CURP ES INVÁLIDO') ||
                    bodyText.includes('TRAMITECURP@SEGOB.GOB.MX')) {
                    return { errorPersonalizado: 'CURP_NO_EXISTENTE' };
                }

                // 2. Aislar únicamente el texto de los resultados (ignora formularios)
                const indexInicio = bodyText.indexOf('DATOS DEL SOLICITANTE');
                let textoResultados = indexInicio !== -1 ? bodyText.substring(indexInicio) : bodyText;
                
                const lineas = textoResultados.split('\n').map(l => l.trim()).filter(l => l.length > 0);

                const extraerValor = (palabrasClave) => {
                    if (!Array.isArray(palabrasClave)) palabrasClave = [palabrasClave];
                    
                    for (let palabra of palabrasClave) {
                        for (let i = 0; i < lineas.length; i++) {
                            const linea = lineas[i];
                            const lineaLimpia = linea.replace(/:/g, '').replace(/\*/g, '').trim();
                            
                            // Si la línea es exactamente la etiqueta, el valor está en la siguiente línea
                            if (lineaLimpia === palabra) {
                                if (i + 1 < lineas.length) {
                                    const valor = lineas[i + 1];
                                    const etiquetasProhibidas = ['NOMBRE(S)', 'NOMBRE', 'PRIMER APELLIDO', 'SEGUNDO APELLIDO', 'SEXO', 'FECHA DE NACIMIENTO', 'NACIONALIDAD', 'ENTIDAD DE NACIMIENTO', 'DOCUMENTO', 'AÑO', 'NÚMERO', 'NUMERO', 'ENTIDAD DE REGISTRO', 'MUNICIPIO', 'DATOS'];
                                    
                                    const esEtiqueta = etiquetasProhibidas.some(e => valor === e || valor.startsWith(e + ':'));
                                    
                                    if (!esEtiqueta && valor.length > 1 && !valor.includes('SELECCIONA') && valor !== '?') {
                                        return valor;
                                    }
                                }
                            } 
                            // Si la etiqueta y el valor quedaron en la misma línea (Ej: "NOMBRE(S): FAUSTO")
                            else if (linea.startsWith(palabra + ':') || linea.startsWith(palabra + ' :')) {
                                const valor = linea.substring(linea.indexOf(':') + 1).trim();
                                if (valor.length > 1 && !valor.includes('SELECCIONA')) return valor;
                            }
                        }
                    }
                    return '';
                };

                // --- INICIO DE GENERACIÓN DE DATOS DESDE CURP ---
                let fechaNac = extraerValor(['FECHA DE NACIMIENTO', 'FECHA NACIMIENTO']);
                if (!fechaNac || fechaNac === 'NO ENCONTRADO') {
                    const anio = curpBuscada.substring(4, 6);
                    const mes = curpBuscada.substring(6, 8);
                    const dia = curpBuscada.substring(8, 10);
                    const homoclave = curpBuscada.charAt(16);
                    const siglo = /[0-9]/.test(homoclave) ? '19' : '20';
                    fechaNac = `${dia}/${mes}/${siglo}${anio}`;
                }

                const letraSexo = curpBuscada.charAt(10).toUpperCase();
                const sexoGenerado = letraSexo === 'H' ? 'HOMBRE' : (letraSexo === 'M' ? 'MUJER' : 'No encontrado');

                const mapaEntidades = {
                    'AS': 'AGUASCALIENTES', 'BC': 'BAJA CALIFORNIA', 'BS': 'BAJA CALIFORNIA SUR',
                    'CC': 'CAMPECHE', 'CL': 'COAHUILA DE ZARAGOZA', 'CM': 'COLIMA', 'CS': 'CHIAPAS',
                    'CH': 'CHIHUAHUA', 'DF': 'CIUDAD DE MEXICO', 'DG': 'DURANGO', 'GT': 'GUANAJUATO',
                    'GR': 'GUERRERO', 'HG': 'HIDALGO', 'JC': 'JALISCO', 'MC': 'MEXICO',
                    'MN': 'MICHOACAN DE OCAMPO', 'MS': 'MORELOS', 'NT': 'NAYARIT', 'NL': 'NUEVO LEON',
                    'OC': 'OAXACA', 'PL': 'PUEBLA', 'QT': 'QUERETARO', 'QR': 'QUINTANA ROO',
                    'SP': 'SAN LUIS POTOSI', 'SL': 'SINALOA', 'SR': 'SONORA', 'TC': 'TABASCO',
                    'TS': 'TAMAULIPAS', 'TL': 'TLAXCALA', 'VZ': 'VERACRUZ DE IGNACIO DE LA LLAVE',
                    'YN': 'YUCATAN', 'ZS': 'ZACATECAS', 'NE': 'NACIDO EN EL EXTRANJERO'
                };
                const claveEntidad = curpBuscada.substring(11, 13).toUpperCase();
                const entidadGenerada = mapaEntidades[claveEntidad] || 'No encontrado';

                let nacionalidadGenerada = '';
                if (claveEntidad !== 'NE') {
                    nacionalidadGenerada = 'MEXICO'; 
                } else {
                    nacionalidadGenerada = extraerValor(['NACIONALIDAD']) || 'No encontrado'; 
                }
                // --- FIN DE GENERACIÓN DE DATOS ---

                return {
                    curp: curpBuscada,
                    nombre: extraerValor(['NOMBRE(S)', 'NOMBRE']) || 'No encontrado',
                    primerApellido: extraerValor(['PRIMER APELLIDO']) || 'No encontrado',
                    segundoApellido: extraerValor(['SEGUNDO APELLIDO']) || 'No encontrado',
                    sexo: sexoGenerado, 
                    fechaNacimiento: fechaNac || 'No encontrado',
                    nacionalidad: nacionalidadGenerada, 
                    entidadNacimiento: entidadGenerada, 
                    docProbatorio: extraerValor(['DOCUMENTO PROBATORIO', 'DOC PROBATORIO']) || 'No encontrado', 
                    anioRegistro: extraerValor(['AÑO REGISTRO', 'AÑO DE REGISTRO']) || 'No encontrado', 
                    numeroActa: extraerValor(['NÚMERO DE ACTA', 'NUMERO DE ACTA']) || 'No encontrado',
                    entidadRegistro: extraerValor(['ENTIDAD DE REGISTRO', 'ENTIDAD REGISTRO']) || 'No encontrado', 
                    municipioRegistro: extraerValor(['MUNICIPIO DE REGISTRO', 'MUNICIPIO REGISTRO']) || 'No encontrado'
                };
            }, curp);

            
            if (datosExtraidos && datosExtraidos.errorPersonalizado === 'CURP_NO_EXISTENTE') {
                await browser.close();
                return res.status(404).json({ error: 'CURP_NO_EXISTENTE' });
            }

            const downloadPath = path.resolve('/tmp', 'curp_' + Date.now());
            fs.mkdirSync(downloadPath, { recursive: true });
            
            const client = await page.target().createCDPSession();
            await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadPath });

            await page.evaluate(() => {
                const botones = Array.from(document.querySelectorAll('a, button'));
                const btnDescargar = botones.find(b => b.innerText.toUpperCase().includes('DESCARGAR PDF'));
                if (btnDescargar) btnDescargar.click();
            });

            let pdfBase64 = null;
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 1000)); 
                const archivos = fs.readdirSync(downloadPath);
                const archivoPdf = archivos.find(f => f.endsWith('.pdf'));
                if (archivoPdf) {
                    pdfBase64 = fs.readFileSync(path.join(downloadPath, archivoPdf)).toString('base64');
                    break; 
                }
            }
            
            datosExtraidos.pdfOficial = pdfBase64;
            await browser.close();
            res.json(datosExtraidos);

        } catch (error) {
            if (browser) await browser.close();
            if (error.message === 'CLIENT_DISCONNECTED') return;
            res.status(500).json({ error: error.message || 'Error al ejecutar el scraping en el servidor' });
        }
    }, req);
});

app.get('/', (req, res) => { res.send(`Servidor Activo y Funcionando`); });

// CÓDIGO DEFINITIVO PARA LA RED DE RAILWAY
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor levantado correctamente en el puerto: ${PORT}`);
});
