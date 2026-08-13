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
                const textoPagina = document.body.innerText || "";
                if (textoPagina.includes('Los datos ingresados no son correctos') || textoPagina.includes('El formato del CURP es inválido')) {
                    return { errorPersonalizado: 'CURP_NO_EXISTENTE' };
                }

                                                                                                               const extraerValor = (palabrasClave) => {
                    if (!Array.isArray(palabrasClave)) palabrasClave = [palabrasClave];
                    
                    // PASO 1: Buscar primero en inputs (por si el valor está en un campo de texto oculto)
                    const elementosInput = Array.from(document.querySelectorAll('td, th, span, div, strong, label, p, b'));
                    for (let palabra of palabrasClave) {
                        const candidatos = elementosInput.filter(el => {
                            const texto = (el.innerText || '').toUpperCase();
                            if (texto.includes('*') || texto.includes('SELECCIONA') || texto.includes('BINARIO') || texto.includes('INGRESA')) return false;
                            return texto.includes(palabra);
                        });
                        
                        if (candidatos.length > 0) {
                            candidatos.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
                            for (let el of candidatos) {
                                const inputs = [];
                                if (el.nextElementSibling && el.nextElementSibling.tagName === 'INPUT') inputs.push(el.nextElementSibling);
                                if (el.parentElement) {
                                    inputs.push(...Array.from(el.parentElement.querySelectorAll('input')));
                                    if (el.parentElement.nextElementSibling) {
                                        inputs.push(...Array.from(el.parentElement.nextElementSibling.querySelectorAll('input')));
                                    }
                                }
                                for (let inp of inputs) {
                                    const val = inp.value ? inp.value.trim().toUpperCase() : '';
                                    if (val.length > 1 && val !== curpBuscada.toUpperCase()) {
                                        return val.replace(/\?/g, '').trim();
                                    }
                                }
                            }
                        }
                    }

                    // PASO 2: Búsqueda aislada por contenedor/fila (Evita que el texto brinque a otras secciones)
                    const allElements = Array.from(document.querySelectorAll('td, th, span, div, strong, label, p, b'));
                    
                    const etiquetasProhibidas = [
                        'PRIMER APELLIDO', 'SEGUNDO APELLIDO', 'NOMBRE(S)', 'NOMBRE', 
                        'SEXO', 'NACIONALIDAD', 'ENTIDAD', 'MUNICIPIO', 'FECHA', 
                        'DOCUMENTO', 'REGISTRO', 'DATOS', 'CLAVE ÚNICA DE REGISTRO DE POBLACIÓN', 'CURP'
                    ];

                    for (let palabra of palabrasClave) {
                        for (let el of allElements) {
                            let textoEl = (el.innerText || el.textContent || '').trim().toUpperCase();
                            
                            // Validar si este elemento contiene la etiqueta exacta que buscamos
                            if (textoEl === palabra || textoEl === palabra + ':' || (textoEl.includes(palabra) && textoEl.length < 35)) {
                                
                                // Encontramos el contenedor o fila (<tr> o div principal de esa línea)
                                let contenedor = el.closest('tr') || el.closest('.row') || el.parentElement || el;
                                
                                // Extraer todos los textos posibles dentro de este mismo contenedor de la fila
                                let candidatosContenedor = Array.from(contenedor.querySelectorAll('td, span, div, label, p, strong'))
                                    .map(e => (e.innerText || e.textContent || '').trim().toUpperCase())
                                    .filter(t => t.length > 1 && t !== '?');

                                // Buscar el valor real que no sea la etiqueta ni la CURP buscada
                                for (let cand of candidatosContenedor) {
                                    let esEtiqueta = etiquetasProhibidas.some(ep => cand === ep || cand.includes(ep));
                                    let esInvalido = cand === palabra || cand === palabra + ':' || cand.includes(curpBuscada.toUpperCase());
                                    
                                    if (!esInvalido && !esEtiqueta && cand.length > 1) {
                                        return cand;
                                    }
                                }
                            }
                        }
                    }
                    return '';
                };



                                               // --- INICIO DE GENERACIÓN DE DATOS DESDE CURP ---
                // 1. Generar Fecha de Nacimiento
                let fechaNac = extraerValor(['FECHA DE NACIMIENTO', 'FECHA NACIMIENTO']);
                if (!fechaNac || fechaNac.toUpperCase() === 'NO ENCONTRADO') {
                    const anio = curpBuscada.substring(4, 6);
                    const mes = curpBuscada.substring(6, 8);
                    const dia = curpBuscada.substring(8, 10);
                    const homoclave = curpBuscada.charAt(16);
                    const siglo = /[0-9]/.test(homoclave) ? '19' : '20';
                    fechaNac = `${dia}/${mes}/${siglo}${anio}`;
                }

                // 2. Generar Sexo (Posición 11 del CURP, índice 10)
                const letraSexo = curpBuscada.charAt(10).toUpperCase();
                const sexoGenerado = letraSexo === 'H' ? 'HOMBRE' : (letraSexo === 'M' ? 'MUJER' : 'No encontrado');

                // 3. Generar Entidad Federativa (Posiciones 12 y 13 del CURP, índices 11 y 12)
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

                // 4. Generar Nacionalidad Híbrida
                let nacionalidadGenerada = '';
                if (claveEntidad !== 'NE') {
                    nacionalidadGenerada = 'MEXICO'; // Generado automático si nació en un estado
                } else {
                    nacionalidadGenerada = extraerValor(['NACIONALIDAD']) || 'No encontrado'; // Scrapea solo si es extranjero
                }
                // --- FIN DE GENERACIÓN DE DATOS ---

                return {
                    curp: curpBuscada,
                    nombre: extraerValor(['NOMBRE(S)', 'NOMBRE']) || 'No encontrado',
                    primerApellido: extraerValor(['PRIMER APELLIDO']) || 'No encontrado',
                    segundoApellido: extraerValor(['SEGUNDO APELLIDO']) || 'No encontrado',
                    sexo: sexoGenerado, // <-- Ahorra RAM
                    fechaNacimiento: fechaNac || 'No encontrado',
                    nacionalidad: nacionalidadGenerada, // <-- Híbrido: Ahorra RAM en el 98% de los casos
                    entidadNacimiento: entidadGenerada, // <-- Ahorra RAM
                    docProbatorio: extraerValor(['DOCUMENTO PROBATORIO', 'DOC PROBATORIO']) || 'No encontrado', 
                    anioRegistro: extraerValor(['AÑO REGISTRO', 'AÑO DE REGISTRO']) || 'No encontrado', 
                    numeroActa: extraerValor(['NÚMERO DE ACTA', 'NUMERO DE ACTA']) || 'No encontrado',
                    entidadRegistro: extraerValor(['ENTIDAD DE REGISTRO']) || 'No encontrado', 
                    municipioRegistro: extraerValor(['MUNICIPIO DE REGISTRO']) || 'No encontrado'
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
