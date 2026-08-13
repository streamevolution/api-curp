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
            await page.waitForSelector('input[name*="curp" i], input[id*="curp" i]', { visible: true, timeout: 20000 });
            await page.type('input[name*="curp" i], input[id*="curp" i]', curp); 
            await page.click('button[type="submit"], #searchButton'); 
            
            await new Promise(r => setTimeout(r, 5000));

            const datosExtraidos = await page.evaluate((curpBuscada) => {
                const textoPagina = document.body.innerText || "";
                if (textoPagina.includes('Los datos ingresados no son correctos') || textoPagina.includes('El formato del CURP es inválido')) {
                    return { errorPersonalizado: 'CURP_NO_EXISTENTE' };
                }

                                                                               const extraerValor = (palabrasClave) => {
                    if (!Array.isArray(palabrasClave)) palabrasClave = [palabrasClave];
                    
                    // MÉTODO DEFINITIVO: Análisis del texto visual de la página
                    // document.body.innerText nos da el texto exactamente como se ve en pantalla,
                    // convirtiendo tablas y columnas en saltos de línea (\n) o tabulaciones (\t).
                    let textoVisual = document.body.innerText || '';
                    
                    let lineas = textoVisual
                        .toUpperCase()
                        .replace(/\t/g, '\n') 
                        .split('\n')
                        .map(l => l.trim())
                        .filter(l => l.length > 0 && l !== '?');
                        
                    // Unimos etiquetas que la página web haya cortado en dos renglones
                    let lineasUnidas = [];
                    for (let i = 0; i < lineas.length; i++) {
                        if (lineas[i] === 'PRIMER' && lineas[i+1] && lineas[i+1].includes('APELLIDO')) {
                            lineasUnidas.push('PRIMER APELLIDO:');
                            i++; // Saltamos la siguiente línea porque ya la unimos
                        } else if (lineas[i] === 'SEGUNDO' && lineas[i+1] && lineas[i+1].includes('APELLIDO')) {
                            lineasUnidas.push('SEGUNDO APELLIDO:');
                            i++;
                        } else if (lineas[i] === 'NOMBRE(S)' || lineas[i] === 'NOMBRE') {
                            lineasUnidas.push('NOMBRE(S):');
                            if (!lineas[i].includes(':') && lineas[i+1] === ':') i++;
                        } else {
                            lineasUnidas.push(lineas[i]);
                        }
                    }

                    for (let palabra of palabrasClave) {
                        for (let i = 0; i < lineasUnidas.length; i++) {
                            let linea = lineasUnidas[i];
                            
                            // Si encontramos la etiqueta (Ej. "NOMBRE(S):")
                            if (linea.includes(palabra)) {
                                // Caso A: El valor está en la misma línea después de los dos puntos
                                if (linea.includes(':')) {
                                    let partes = linea.split(':');
                                    let valor = partes.slice(1).join(':').trim();
                                    if (valor.length > 1 && valor !== curpBuscada.toUpperCase()) {
                                        return valor;
                                    }
                                }
                                
                                // Caso B: El valor está en la siguiente línea visual
                                if (i + 1 < lineasUnidas.length) {
                                    let valorSiguiente = lineasUnidas[i + 1];
                                    
                                    // Bloqueamos cualquier texto basura que haya capturado por error
                                    const basura = [
                                        'APELLIDO', 'NOMBRE', 'SEXO', 'NACIONALIDAD', 'ENTIDAD', 
                                        'MUNICIPIO', 'DÍA DE NACIMIENTO', 'DIA DE NACIMIENTO', 
                                        'DATOS', 'REGISTRO', 'DOCUMENTO', 'ESTADO', 'CLAVE'
                                    ];
                                    
                                    let esBasura = basura.some(b => valorSiguiente.includes(b));
                                    
                                    if (!esBasura && valorSiguiente !== curpBuscada.toUpperCase()) {
                                        return valorSiguiente;
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
                    nacionalidadGenerada = 'MEXICANA'; // Generado automático si nació en un estado
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
