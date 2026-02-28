const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors({ origin: '*' }));

app.get('/scrape-curp', async (req, res) => {
    const curp = req.query.curp;
    
    if (!curp || curp.length !== 18) {
        return res.status(400).json({ error: 'CURP inválido' });
    }

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
                '--disable-extensions'
            ]
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        
        const urlObjetivo = 'https://www.gob.mx/curp/'; 
        await page.goto(urlObjetivo, { waitUntil: 'networkidle2', timeout: 30000 });
        
        await page.waitForSelector('input[name*="curp" i], input[id*="curp" i]', { visible: true, timeout: 10000 });
        await page.type('input[name*="curp" i], input[id*="curp" i]', curp); 
        
        await page.click('button[type="submit"], #searchButton'); 
        
        await new Promise(r => setTimeout(r, 5000));

        const datosExtraidos = await page.evaluate(() => {
            const extraerValor = (palabraClave) => {
                const elementos = Array.from(document.querySelectorAll('td, th, span, div, strong, label, p'));
                const etiqueta = elementos.find(el => 
                    el.children.length === 0 && 
                    el.innerText.trim().toUpperCase().includes(palabraClave)
                );
                
                if (etiqueta) {
                    if (etiqueta.nextElementSibling) {
                        return etiqueta.nextElementSibling.innerText.trim();
                    } else if (etiqueta.parentElement && etiqueta.parentElement.nextElementSibling) {
                        return etiqueta.parentElement.nextElementSibling.innerText.trim();
                    }
                }
                return '';
            };

            return {
                nombre: extraerValor('NOMBRE') || 'No encontrado',
                primerApellido: extraerValor('PRIMER APELLIDO') || 'No encontrado',
                segundoApellido: extraerValor('SEGUNDO APELLIDO') || 'No encontrado',
                docProbatorio: extraerValor('DOCUMENTO PROBATORIO') || 'No encontrado', 
                anioRegistro: extraerValor('AÑO DE REGISTRO') || 'No encontrado', 
                entidadRegistro: extraerValor('ENTIDAD DE REGISTRO') || 'No encontrado', 
                municipioRegistro: extraerValor('MUNICIPIO DE REGISTRO') || 'No encontrado'
            };
        });

        await browser.close();
        res.json(datosExtraidos);

    } catch (error) {
        if (browser) await browser.close();
        res.status(500).json({ error: error.message || 'Error al ejecutar el scraping en el servidor' });
    }
});

app.get('/', (req, res) => {
    res.status(200).send('¡El servidor de Cafirexos responde exitosamente a internet!');
});

const PORT = process.env.SERVER_PORT || process.env.PORT || 5330;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor de web scraping conectado exitosamente a internet en el puerto ${PORT}`);
}).on('error', (err) => {
    console.error('Fallo grave al abrir el puerto:', err.message);
});
