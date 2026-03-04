const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));

// --- 1. ENDPOINT PARA CURP ---
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
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-gpu', '--no-first-run', '--no-zygote', '--single-process', '--disable-extensions'
            ]
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        
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
                const etiquetas = elementos.filter(el => {
                    const texto = el.innerText.trim().toUpperCase();
                    return el.children.length === 0 && palabrasClave.some(palabra => texto.includes(palabra));
                });
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
                const buffer = fs.readFileSync(path.join(downloadPath, archivoPdf));
                pdfBase64 = buffer.toString('base64');
                break; 
            }
        }
        
        datosExtraidos.pdfOficial = pdfBase64;
        await browser.close();
        res.json(datosExtraidos);

    } catch (error) {
        if (browser) await browser.close();
        res.status(500).json({ error: error.message || 'Error al ejecutar el scraping en el servidor' });
    }
});

// --- 2. ENDPOINT PARA CÓDIGOS POSTALES (SOLO NÚMEROS) ---
app.get('/scrape-cp', async (req, res) => {
    const cp = req.query.cp;
    
    if (!cp || cp.length !== 5 || isNaN(cp)) {
        return res.status(400).json({ error: 'El código postal debe tener 5 números' });
    }

    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        
        await page.goto(`https://micodigopostal.org/codigo-postal/${cp}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        const datosCp = await page.evaluate(() => {
            const textoPagina = document.body.innerText;
            if (textoPagina.includes('No encontramos resultados') || textoPagina.includes('no existe')) {
                return { error: 'CP_NO_EXISTENTE' };
            }

            let resultadosCompletos = [];
            document.querySelectorAll('tbody tr').forEach(fila => {
                const columnas = fila.querySelectorAll('td');
                if (columnas.length >= 7) {
                    resultadosCompletos.push({
                        asentamiento: columnas[0].innerText.trim(), 
                        tipo: columnas[1].innerText.trim(), 
                        cp: columnas[2].innerText.trim(),
                        municipio: columnas[3].innerText.trim(), 
                        estado: columnas[4].innerText.trim(), 
                        ciudad: columnas[5].innerText.trim(), 
                        zona: columnas[6].innerText.trim()
                    });
                }
            });
            return { resultadosCompletos: resultadosCompletos };
        });

        await browser.close();

        if (datosCp.error === 'CP_NO_EXISTENTE' || datosCp.resultadosCompletos.length === 0) {
            return res.status(404).json({ error: 'Código Postal no encontrado' });
        }
        res.json({ resultadosCompletos: datosCp.resultadosCompletos });

    } catch (error) {
        if (browser) await browser.close();
        res.status(500).json({ error: error.message || 'Error al buscar el código postal' });
    }
});

// --- 3. ENDPOINT PARA BÚSQUEDA POR TEXTO (CIUDAD, COLONIA, ETC) ---
app.get('/scrape-buscar', async (req, res) => {
    const query = req.query.q;
    
    if (!query || query.length < 3) {
        return res.status(400).json({ error: 'La búsqueda debe tener al menos 3 letras o números' });
    }

    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        
        // --- AQUÍ ESTÁ LA SOLUCIÓN DEFINITIVA (RUTA SECRETA DE LA PÁGINA) ---
        const urlObjetivo = `https://micodigopostal.org/buscarcp.php?buscar=${encodeURIComponent(query)}`;
        
        await page.goto(urlObjetivo, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        const datosBusqueda = await page.evaluate(() => {
            const textoPagina = document.body.innerText;
            if (textoPagina.includes('No encontramos resultados') || textoPagina.includes('no existe')) {
                return { error: 'SIN_RESULTADOS' };
            }

            let resultadosCompletos = [];
            document.querySelectorAll('tbody tr').forEach(fila => {
                const columnas = fila.querySelectorAll('td');
                if (columnas.length >= 7) {
                    resultadosCompletos.push({
                        asentamiento: columnas[0].innerText.trim(), 
                        tipo: columnas[1].innerText.trim(), 
                        cp: columnas[2].innerText.trim(),
                        municipio: columnas[3].innerText.trim(), 
                        estado: columnas[4].innerText.trim(), 
                        ciudad: columnas[5].innerText.trim(), 
                        zona: columnas[6].innerText.trim()
                    });
                }
            });

            return { resultadosCompletos: resultadosCompletos };
        });

        await browser.close();

        if (datosBusqueda.error === 'SIN_RESULTADOS' || datosBusqueda.resultadosCompletos.length === 0) {
            return res.status(404).json({ error: 'No se encontraron resultados para esta búsqueda' });
        }

        res.json({ resultadosCompletos: datosBusqueda.resultadosCompletos });

    } catch (error) {
        if (browser) await browser.close();
        res.status(500).json({ error: error.message || 'Error en la búsqueda' });
    }
});

// --- RUTA PRINCIPAL (Para no romper tu entorno de pruebas) ---
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Buscador de CURP</title>
    <style>
        body { font-family: Arial, sans-serif; background-color: #f0f2f5; padding: 20px; }
        .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
        h2 { text-align: center; color: #333; }
        input[type="text"] { width: 100%; padding: 12px; margin: 15px 0; border: 1px solid #ccc; border-radius: 5px; text-transform: uppercase; font-size: 16px; box-sizing: border-box; }
        button { width: 100%; padding: 12px; background-color: #0066cc; color: white; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; }
        button:hover { background-color: #004c99; }
        .mensaje { text-align: center; font-weight: bold; margin-top: 15px; color: #d9534f; }
        .cargando { color: #f0ad4e; }
        .resultado { margin-top: 20px; padding: 15px; background-color: #e9ecef; border-radius: 5px; display: none; }
        .resultado p { margin: 5px 0; font-size: 15px; }
        .resultado strong { color: #333; }
    </style>
</head>
<body>

<div class="container">
    <h2>Consulta de CURP</h2>
    <input type="text" id="curpInput" placeholder="Escribe la CURP a 18 posiciones" maxlength="18">
    <button onclick="consultarCurp()">Buscar CURP</button>

    <div id="estadoMensaje" class="mensaje"></div>

    <div id="cajaResultado" class="resultado">
        <p><strong>Nombre(s):</strong> <span id="resNombre"></span></p>
        <p><strong>Primer Apellido:</strong> <span id="resApellido1"></span></p>
        <p><strong>Segundo Apellido:</strong> <span id="resApellido2"></span></p>
        <p><strong>Doc. Probatorio:</strong> <span id="resDoc"></span></p>
        <p><strong>Año de Registro:</strong> <span id="resAnio"></span></p>
        <p><strong>Entidad de Registro:</strong> <span id="resEntidad"></span></p>
        <p><strong>Municipio de Registro:</strong> <span id="resMunicipio"></span></p>
    </div>
</div>

<script>
    async function consultarCurp() {
        const curp = document.getElementById('curpInput').value.trim().toUpperCase();
        const mensaje = document.getElementById('estadoMensaje');
        const cajaResultado = document.getElementById('cajaResultado');

        cajaResultado.style.display = 'none';
        mensaje.innerText = '';
        mensaje.className = 'mensaje';

        if (curp.length !== 18) {
            mensaje.innerText = '⚠️ La CURP debe tener exactamente 18 caracteres.';
            return;
        }

        mensaje.innerText = '⏳ Buscando en RENAPO, por favor espera unos segundos...';
        mensaje.className = 'mensaje cargando';

        try {
            const url = '/scrape-curp?curp=' + curp;
            const respuesta = await fetch(url);
            const datos = await respuesta.json();

            if (!respuesta.ok) throw new Error(datos.error || 'Ocurrió un error al buscar la CURP.');

            document.getElementById('resNombre').innerText = datos.nombre;
            document.getElementById('resApellido1').innerText = datos.primerApellido;
            document.getElementById('resApellido2').innerText = datos.segundoApellido;
            document.getElementById('resDoc').innerText = datos.docProbatorio;
            document.getElementById('resAnio').innerText = datos.anioRegistro;
            document.getElementById('resEntidad').innerText = datos.entidadRegistro;
            document.getElementById('resMunicipio').innerText = datos.municipioRegistro;

            mensaje.innerText = '';
            cajaResultado.style.display = 'block';

        } catch (error) {
            mensaje.innerText = '❌ Error: ' + error.message;
            mensaje.className = 'mensaje';
        }
    }
</script>
</body>
</html>`);
});

app.listen(5330, '0.0.0.0', () => {
    console.log("Servidor conectado en el puerto 5330");
});
