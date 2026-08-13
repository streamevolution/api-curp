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
                    
                    // PASO 1: Buscar en Inputs (Ocultos o de solo lectura)
                    const elementos = Array.from(document.querySelectorAll('td, th, span, div, strong, label, p, b'));
                    for (let palabra of palabrasClave) {
                        const candidatos = elementos.filter(el => {
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

                    // PASO 2: Escanear los nodos de texto puros de la página en fila india
                    const walker = document.createTreeWalker(
                        document.body,
                        NodeFilter.SHOW_TEXT,
                        { acceptNode: function(node) {
                            if (node.nodeValue.trim().length > 0 && node.nodeValue.trim() !== '?') {
                                return NodeFilter.FILTER_ACCEPT;
                            }
                            return NodeFilter.FILTER_REJECT;
                        }},
                        false
                    );

                    let textosEscaneados = [];
                    let nodoActual;
                    while((nodoActual = walker.nextNode())) {
                        textosEscaneados.push(nodoActual.nodeValue.trim().toUpperCase());
                    }

                    // Etiquetas del sistema que jamás deben tomarse como un Nombre o Apellido real
                    const etiquetasProhibidas = [
                        'PRIMER APELLIDO', 'PRIMER APELLIDO:', 'SEGUNDO APELLIDO', 'SEGUNDO APELLIDO:', 
                        'NOMBRE(S)', 'NOMBRE(S):', 'NOMBRE', 'NOMBRE:', 'SEXO', 'SEXO:', 'HOMBRE', 'MUJER',
                        'NACIONALIDAD', 'NACIONALIDAD:', 'ENTIDAD', 'ENTIDAD:', 'MUNICIPIO', 'MUNICIPIO:',
                        'FECHA', 'FECHA DE NACIMIENTO', 'FECHA DE NACIMIENTO:', 'DOCUMENTO', 'REGISTRO', 
                        'DATOS', 'DÍA DE NACIMIENTO', 'DIA DE NACIMIENTO', 'DATOS DEL SOLICITANTE', 
                        'DATOS DEL DOCUMENTO PROBATORIO'
                    ];

                    for (let palabra of palabrasClave) {
                        for (let i = 0; i < textosEscaneados.length; i++) {
                            let texto = textosEscaneados[i];
                            
                            if (texto.includes(palabra)) {
                                
                                // Caso A: El valor está pegado en el mismo texto (Ej. "Nombre: JUAN")
                                if (texto.includes(':')) {
                                    let partes = texto.split(':');
                                    if (partes.length > 1 && partes[1].trim().length > 1) {
                                        let valor = partes.slice(1).join(':').trim();
                                        if (valor !== curpBuscada.toUpperCase() && !etiquetasProhibidas.includes(valor)) {
                                            return valor;
                                        }
                                    }
                                }
                                
                                // Caso B: El valor está en los siguientes fragmentos (busca hacia adelante 4 pasos)
                                for (let j = 1; j <= 4; j++) {
                                    if (i + j < textosEscaneados.length) {
                                        let textoSiguiente = textosEscaneados[i + j];
                                        
                                        // Brincamos signos sueltos
                                        if (textoSiguiente === ':' || textoSiguiente === '*' || textoSiguiente.includes('SELECCIONA')) continue;
                                        
                                        // Validamos que el texto que va a atrapar no sea una etiqueta de la página
                                        let esEtiqueta = etiquetasProhibidas.includes(textoSiguiente);
                                        
                                        if (!esEtiqueta && textoSiguiente !== curpBuscada.toUpperCase() && textoSiguiente.length > 1) {
                                            return textoSiguiente;
                                        }
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
