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
                if (textoPagina.includes('Los datos ingresados no son correctos') || textoPagina.includes('El formato del CURP es inválido') || textoPagina.includes('no existe')) {
                    return { errorPersonalizado: 'CURP_NO_EXISTENTE' };
                }

                // Extracción visual indestructible
                let textos = [];
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
                    acceptNode: function(node) {
                        let parent = node.parentElement;
                        if (parent) {
                            let style = window.getComputedStyle(parent);
                            if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
                            if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
                        }
                        return NodeFilter.FILTER_ACCEPT;
                    }
                }, false);

                let n;
                while(n = walker.nextNode()) {
                    let val = n.nodeValue.trim();
                    if (val) textos.push(val.toUpperCase());
                }

                const extraerValor = (claves) => {
                    if (!Array.isArray(claves)) claves = [claves];
                    
                    for (let i = 0; i < textos.length; i++) {
                        let textoCompleto = textos[i];
                        
                        for (let clave of claves) {
                            if (textoCompleto.startsWith(clave + ':') || textoCompleto.startsWith(clave + ' :')) {
                                let valorPegado = textoCompleto.substring(textoCompleto.indexOf(':') + 1).replace(/^[:*\s]+/, '').trim();
                                if (valorPegado) return valorPegado;
                            }
                            
                            let txtLimpio = textoCompleto.replace(/:$/, '').trim();
                            if (txtLimpio === clave) {
                                for(let j = i + 1; j <= i + 4 && j < textos.length; j++) {
                                    let sig = textos[j];
                                    if (sig !== '*' && sig !== '*:' && !sig.includes('SELECCIONAR')) {
                                        return sig;
                                    }
                                }
                            }
                        }
                    }
                    return 'No encontrado';
                };

                let fechaNac = extraerValor(['FECHA DE NACIMIENTO', 'FECHA NACIMIENTO']);
                if (!fechaNac || fechaNac === 'No encontrado') {
                    const anio = curpBuscada.substring(4, 6);
                    const mes = curpBuscada.substring(6, 8);
                    const dia = curpBuscada.substring(8, 10);
                    const homoclave = curpBuscada.charAt(16);
                    const siglo = /[0-9]/.test(homoclave) ? '19' : '20';
                    fechaNac = `${dia}/${mes}/${siglo}${anio}`;
                }

                return {
                    curp: curpBuscada,
                    nombre: extraerValor(['NOMBRE(S)', 'NOMBRES', 'NOMBRE']),
                    primerApellido: extraerValor(['PRIMER APELLIDO']),
                    segundoApellido: extraerValor(['SEGUNDO APELLIDO']),
                    sexo: extraerValor(['SEXO']),
                    fechaNacimiento: fechaNac,
                    nacionalidad: extraerValor(['NACIONALIDAD']),
                    entidadNacimiento: extraerValor(['ENTIDAD DE NACIMIENTO', 'ESTADO DE NACIMIENTO']),
                    docProbatorio: extraerValor(['DOCUMENTO PROBATORIO', 'DOC PROBATORIO']), 
                    anioRegistro: extraerValor(['AÑO DE REGISTRO', 'AÑO REGISTRO', 'ANO DE REGISTRO']), 
                    numeroActa: extraerValor(['NUMERO DE ACTA', 'NÚMERO DE ACTA']),
                    entidadRegistro: extraerValor(['ENTIDAD DE REGISTRO']), 
                    municipioRegistro: extraerValor(['MUNICIPIO DE REGISTRO'])
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
