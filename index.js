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
        
        // Si el usuario cierra la pestaña o Render corta la conexión, lo marcamos
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

// Límite de 1 para evitar que Render se quede sin memoria RAM
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
                    // --- MODO BAJO CONSUMO DE RAM PARA RENDER ---
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
                    const elementos = Array.from(document.querySelectorAll('td, th, span, div, strong, label, p'));
                    const etiquetas = elementos.filter(el => el.children.length === 0 && palabrasClave.some(palabra => el.innerText.trim().toUpperCase().includes(palabra)));
                    
                    for (let etiqueta of etiquetas) {
                        let valorEncontrado = '';
                        const textoCompleto = etiqueta.innerText.trim();
                        if (textoCompleto.includes(':')) {
                            const partes = textoCompleto.split(':');
                            if (partes.length > 1 && partes[1].trim() !== '') valorEncontrado = partes[1].trim();
                        }
                        if (!valorEncontrado && etiqueta.nextElementSibling && etiqueta.nextElementSibling.innerText.trim() !== '') {
                            valorEncontrado = etiqueta.nextElementSibling.innerText.trim();
                        } else if (!valorEncontrado && etiqueta.parentElement && etiqueta.parentElement.nextElementSibling) {
                            valorEncontrado = etiqueta.parentElement.nextElementSibling.innerText.trim();
                        }
                        if (valorEncontrado && valorEncontrado.length > 2) return valorEncontrado;
                    }
                    return '';
                };

                let fechaNac = extraerValor(['FECHA DE NACIMIENTO', 'FECHA NACIMIENTO']);
                if (!fechaNac || fechaNac.toUpperCase() === 'NO ENCONTRADO') {
                    const anio = curpBuscada.substring(4, 6);
                    const mes = curpBuscada.substring(6, 8);
                    const dia = curpBuscada.substring(8, 10);
                    const homoclave = curpBuscada.charAt(16);
                    const siglo = /[0-9]/.test(homoclave) ? '19' : '20';
                    fechaNac = `${dia}/${mes}/${siglo}${anio}`;
                }

                return {
                    curp: curpBuscada,
                    nombre: extraerValor('NOMBRE') || 'No encontrado',
                    primerApellido: extraerValor('PRIMER APELLIDO') || 'No encontrado',
                    segundoApellido: extraerValor('SEGUNDO APELLIDO') || 'No encontrado',
                    sexo: extraerValor('SEXO') || 'No encontrado',
                    fechaNacimiento: fechaNac || 'No encontrado',
                    nacionalidad: extraerValor('NACIONALIDAD') || 'No encontrado',
                    entidadNacimiento: extraerValor(['ENTIDAD DE NACIMIENTO', 'ESTADO DE NACIMIENTO']) || 'No encontrado',
                    docProbatorio: extraerValor(['DOCUMENTO PROBATORIO', 'DOC PROBATORIO']) || 'No encontrado', 
                    anioRegistro: extraerValor(['AÑO DE REGISTRO', 'AÑO REGISTRO', 'ANO DE REGISTRO']) || 'No encontrado', 
                    numeroActa: extraerValor(['NUMERO DE ACTA', 'NÚMERO DE ACTA']) || 'No encontrado',
                    entidadRegistro: extraerValor('ENTIDAD DE REGISTRO') || 'No encontrado', 
                    municipioRegistro: extraerValor('MUNICIPIO DE REGISTRO') || 'No encontrado'
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

// --- 2. ENDPOINT CÓDIGOS POSTALES (ELIMINADO) ---


// --- 3. ENDPOINT BÚSQUEDA POR TEXTO (ELIMINADO) ---


app.get('/', (req, res) => { res.send(`Servidor Activo y Funcionando`); });

app.listen(5330, '0.0.0.0', () => {
    console.log("Servidor conectado en el puerto 5330");
});
