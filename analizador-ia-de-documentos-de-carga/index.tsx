/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI, Type } from '@google/genai';
import * as pdfjsLib from 'pdfjs-dist';
import * as Tesseract from 'tesseract.js';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// Set the worker URL for pdf.js
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@4.4.168/build/pdf.worker.mjs`;

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Web service del FMM (ver Boris Beltrán, reunión 2026-09-01): se busca el FMM
// por número de formulario en vez de cargar el JSON manualmente.
const FMM_API_URL = process.env.FMM_API_URL || 'http://www.siza.com.co/spdcitas-1.0/api/formulario';
const FMM_API_TOKEN = process.env.FMM_API_TOKEN;

// DOM Elements
const fmmNumberInput = document.getElementById('fmm-number-input') as HTMLInputElement;
const fmmSearchButton = document.getElementById('fmm-search-button') as HTMLButtonElement;
const fmmSelectionPrompt = document.getElementById('fmm-selection-prompt') as HTMLSpanElement;
const folderInput = document.getElementById('folder-input') as HTMLInputElement;
const folderSelectionPrompt = document.getElementById('folder-selection-prompt') as HTMLSpanElement;
const clearButton = document.getElementById('clear-button') as HTMLButtonElement;
const resultContainer = document.getElementById('result-container') as HTMLDivElement;

// FMM (Documento Base) types - reflejan el JSON exportado por el sistema de origen
interface FmmArticulo {
    coditem: string;
    descripcion_item: string;
    cantidad: number;
    ptprecio: number;
    nmconversion: number;
    unidad_medida: string;
}

interface FmmSubpartida {
    codsp: string;
    codempaque: string;
    pesobruto: number;
    pesoneto: number;
    nro_bultos: number;
    codbandera: string | null;
    codorigen: string | null;
    tasacambio: number;
    codcompra: string | null;
    coddestino: string | null;
    codprocedencia: string | null;
    transporte: string | null;
    fletes: number;
    seguro: number;
    otrosgastos: number;
    fob: number;
    umedida_sp: string;
    cantidad_art: number;
    tran_articulos: FmmArticulo[];
}

interface FmmComplemento {
    dsanexo: string;
    nmdoc: string | null;
    dscomentario: string | null;
    fecomple: string | null;
}

interface FmmDocument {
    nro_form: number;
    codtransac: string;
    coddoc_transp: string | null;
    coddoc_expor: string | null;
    codfactura: string;
    dscomentario: string | null;
    nitTercero: string;
    nombreTercero: string;
    dias: number;
    tran_subpartidas: FmmSubpartida[];
    complementos: FmmComplemento[];
}

// State
let tesseractWorker: Tesseract.Worker | null = null;

let baseDocumentJson: FmmDocument | null = null;
let baseDocumentFile: File | null = null;
let supportDocuments: File[] = [];

let selectedSupportFiles: File[] = [];


async function getTesseractWorker() {
    if (!tesseractWorker) {
        updateUIState('loading', 'Cargando motor OCR...');
        tesseractWorker = await Tesseract.createWorker('spa', 1, {
            logger: m => {
                if (m.status === 'recognizing text') {
                    const progress = (m.progress * 100).toFixed(0);
                     updateUIState('loading', `Procesando OCR... ${progress}%`);
                }
            }
        });
    }
    return tesseractWorker;
}

const responseSchema = {
    type: Type.OBJECT,
    properties: {
        fmm_number: {
            type: Type.STRING,
            description: "El número EXACTO del 'Formulario de Movimiento de Mercancías' (FMM) extraído del documento base. Busca etiquetas como 'Formulario No.', 'Número de Formulario', etc. Si no se encuentra, el valor DEBE ser 'No encontrado'."
        },
        general_reasoning: {
            type: Type.STRING,
            description: "Un resumen general del análisis, destacando las coincidencias o discrepancias más importantes."
        },
        overall_match: {
            type: Type.BOOLEAN,
            description: "Verdadero si todos los campos críticos coinciden, falso si hay alguna discrepancia importante."
        },
        comparison_results: {
            type: Type.ARRAY,
            description: "Una lista detallada de la comparación campo por campo.",
            items: {
                type: Type.OBJECT,
                properties: {
                    field_name: { type: Type.STRING, description: "El nombre del campo que se compara (ej. 'Número de Factura', 'Origen')." },
                    base_value: { type: Type.STRING, description: "El valor del campo encontrado en el documento base. 'No encontrado' si no está presente." },
                    base_source_doc: { type: Type.STRING, description: "El nombre del archivo del documento base donde se encontró el valor. 'N/A' si no se encontró." },
                    support_value: { type: Type.STRING, description: "El valor del campo encontrado en los documentos de soporte. 'No encontrado' si no está presente." },
                    support_source_doc: { type: Type.STRING, description: "El nombre del archivo del documento de soporte donde se encontró el valor. Si hay varios, nombrar el más relevante. 'N/A' si no se encontró." },
                    match: { type: Type.BOOLEAN, description: "Verdadero si los valores coinciden, son compatibles o ambos están ausentes. Falso si hay una clara discrepancia." },
                    reasoning: {
                        type: Type.STRING,
                        description: "Explicación opcional sobre la lógica de la coincidencia. Usar para: 1. Inferencia del tipo de transporte (ej. 'Detectado B/L, por lo tanto Marítimo'). 2. Coincidencias jerárquicas (ej. 'Coincide porque Barrancabermeja está en Colombia'). 3. Reglas de negocio especiales (ej. 'Doc. Transporte no es obligatorio para origen nacional'). 4. Faltantes en listas (ej. 'Falta la factura X')."
                    }
                },
                required: ["field_name", "base_value", "base_source_doc", "support_value", "support_source_doc", "match"]
            }
        },
        articles_comparison: {
            type: Type.ARRAY,
            description: "Una comparación detallada de los artículos, desglosando cada uno en nombre, cantidad y costo.",
            items: {
                type: Type.OBJECT,
                description: "Una comparación detallada de un solo artículo/producto listado en los documentos.",
                properties: {
                    item_description: { type: Type.STRING, description: "Nombre principal o descripción del artículo que se está comparando." },
                    name_comparison: {
                        type: Type.OBJECT,
                        description: "Comparación del nombre/descripción del artículo.",
                        properties: {
                            base_value: { type: Type.STRING, description: "Nombre/descripción en el doc base." },
                            support_value: { type: Type.STRING, description: "Nombre/descripción en el doc de soporte." },
                            match: { type: Type.BOOLEAN, description: "True si los nombres son semánticamente equivalentes o describen el mismo producto, incluso con variaciones menores. Falso si son claramente productos diferentes." }
                        },
                        required: ["base_value", "support_value", "match"]
                    },
                    quantity_comparison: {
                        type: Type.OBJECT,
                        description: "Comparación de la cantidad del artículo.",
                        properties: {
                            base_value: { type: Type.STRING, description: "Cantidad en el doc base (ej. '100', '100 cajas')." },
                            support_value: { type: Type.STRING, description: "Cantidad en el doc de soporte." },
                            match: { type: Type.BOOLEAN, description: "True si las cantidades coinciden, ya sea directamente o después de aplicar una conversión de unidades." },
                            reasoning: { type: Type.STRING, description: "Opcional. Explicación si la coincidencia se logró a través de una conversión de unidades." }
                        },
                        required: ["base_value", "support_value", "match"]
                    },
                    cost_comparison: {
                        type: Type.OBJECT,
                        description: "Comparación del costo unitario Y total del artículo. El 'match' individual es true si los valores son idénticos, la diferencia es de hasta un 5%, o ambos no se encuentran. Debe considerar la tasa de cambio si las monedas difieren.",
                        properties: {
                            unit_cost: {
                                type: Type.OBJECT,
                                description: "Comparación del costo por unidad.",
                                properties: {
                                    base_value: { type: Type.STRING, description: "Costo unitario en el doc base (ej. '100 USD', '50,000 COP'). 'No encontrado' si no está presente." },
                                    support_value: { type: Type.STRING, description: "Costo unitario en el doc de soporte. 'No encontrado' si no está presente." },
                                    match: { type: Type.BOOLEAN, description: "True si los costos unitarios coinciden (con tolerancia de ~5%) o si ambos no se encuentran. Considera la tasa de cambio si las monedas son diferentes." }
                                },
                                required: ["base_value", "support_value", "match"]
                            },
                            total_cost: {
                                type: Type.OBJECT,
                                description: "Comparación del costo total para el artículo (cantidad * costo unitario).",
                                properties: {
                                    base_value: { type: Type.STRING, description: "Costo total en el doc base. 'No encontrado' si no está presente." },
                                    support_value: { type: Type.STRING, description: "Costo total en el doc de soporte. 'No encontrado' si no está presente." },
                                    match: { type: Type.BOOLEAN, description: "True si los costos totales coinciden (con tolerancia de ~5%) o si ambos no se encuentran. Considera la tasa de cambio si las monedas son diferentes." }
                                },
                                required: ["base_value", "support_value", "match"]
                            },
                            overall_match: { type: Type.BOOLEAN, description: "True si tanto el costo unitario como el costo total (si ambos están disponibles) coinciden. Si solo uno está disponible, su coincidencia determina este valor." },
                            reasoning: { type: Type.STRING, description: "Opcional. Explicación general si hay algo notable, como una discrepancia entre el costo unitario y el total." }
                        },
                        required: ["unit_cost", "total_cost", "overall_match"]
                    },
                    reasoning: { type: Type.STRING, description: "Opcional. Explicación general para este artículo si hay algo notable. Si 'name_comparison.match' es falso, explica aquí por qué los nombres no son equivalentes." },
                    unit_conversion_analysis: {
                        type: Type.OBJECT,
                        description: "Análisis de conversión de unidades. Rellenar SOLO si las unidades no coinciden Y se puede realizar una conversión con el archivo Excel. Si no, omitir este campo.",
                        properties: {
                            base_quantity: { type: Type.NUMBER, description: "Cantidad numérica del doc base." },
                            base_unit: { type: Type.STRING, description: "Unidad del doc base." },
                            support_quantity: { type: Type.NUMBER, description: "Cantidad numérica del doc de soporte." },
                            support_unit: { type: Type.STRING, description: "Unidad del doc de soporte." },
                            units_match: { type: Type.BOOLEAN, description: "¿Coinciden las unidades textualmente?" },
                            conversion_applied: { type: Type.BOOLEAN, description: "True si se usó el Excel para convertir." },
                            conversion_factor_used: { type: Type.NUMBER, description: "Factor de conversión 'NMCONVERSION' aplicado." },
                            converted_support_quantity: { type: Type.NUMBER, description: "Cantidad de soporte convertida a la unidad base." },
                            final_validation_status: {
                                type: Type.STRING,
                                description: "Estado final: '✅ Coincide', '❌ Cantidad incorrecta', '⚠️ Falta conversión', '⚠️ Duda en emparejamiento'."
                            }
                        }
                    }
                },
                required: ["item_description", "name_comparison", "quantity_comparison", "cost_comparison"]
            }
        },
        cost_comparison: {
            type: Type.OBJECT,
            description: "Una comparación de los costos totales. Primero se extraen y suman todos los valores CIF del documento base (agrupados por USD y COP). Luego se extraen y suman los valores totales de las facturas de soporte. Finalmente, se comparan los grandes totales.",
            properties: {
                base_doc_cif_values: {
                    type: Type.ARRAY,
                    description: "Una lista de CADA valor CIF individual extraído TEXTUALMENTE del documento base, con su moneda y subpartida de origen.",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            subpartida: { type: Type.STRING, description: "La subpartida de la que se extrajo el valor." },
                            value_str: { type: Type.STRING, description: "El valor extraído textualmente (ej: '234,340,684.2811', '56,432.4155')." },
                            value_num: { type: Type.NUMBER, description: "El valor numérico extraído SIN comas (ej: 234340684.2811)." },
                            currency: { type: Type.STRING, description: "La moneda del valor ('USD' o 'COP')." }
                        },
                        required: ["subpartida", "value_str", "value_num", "currency"]
                    }
                },
                base_doc_totals: {
                    type: Type.ARRAY,
                    description: "Los GRANDES TOTALES para el documento base, calculados sumando todos los valores CIF por moneda, con sus equivalentes convertidos si hay tasa de cambio.",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            currency: { type: Type.STRING, description: "Código de la moneda ('USD', 'COP')." },
                            total: { type: Type.NUMBER, description: "La suma total para esa moneda." },
                            converted_total: { type: Type.NUMBER, description: "El valor total convertido a la moneda opuesta usando la tasa de cambio. Si no se puede convertir, no incluir este campo." },
                            converted_currency: { type: Type.STRING, description: "La moneda del valor convertido (ej. 'COP'). Si no se puede convertir, no incluir este campo." }
                        },
                        required: ["currency", "total"]
                    }
                },
                support_docs_invoice_values: {
                    type: Type.ARRAY,
                    description: "Una lista que contiene UN ÚNICO valor total por cada factura de soporte (y por cada moneda si hay varias). NO incluyas valores de artículos individuales; solo el gran total final de la factura ANTES de cualquier deducción o retención.",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            source_doc: { type: Type.STRING, description: "El nombre del archivo de la factura de soporte." },
                            value_str: { type: Type.STRING, description: "El valor extraído textualmente." },
                            value_num: { type: Type.NUMBER, description: "El valor numérico." },
                            currency: { type: Type.STRING, description: "La moneda ('USD', 'COP', etc.)." }
                        },
                        required: ["source_doc", "value_str", "value_num", "currency"]
                    }
                },
                support_docs_totals: {
                    type: Type.ARRAY,
                    description: "Los GRANDES TOTALES para los documentos de soporte, calculados sumando todos los valores de las facturas por moneda, con sus equivalentes convertidos si hay tasa de cambio.",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            currency: { type: Type.STRING, description: "Código de la moneda ('USD', 'COP')." },
                            total: { type: Type.NUMBER, description: "La suma total para esa moneda." },
                            converted_total: { type: Type.NUMBER, description: "El valor total convertido a la moneda opuesta usando la tasa de cambio. Si no se puede convertir, no incluir este campo." },
                            converted_currency: { type: Type.STRING, description: "La moneda del valor convertido (ej. 'COP'). Si no se puede convertir, no incluir este campo." }
                        },
                        required: ["currency", "total"]
                    }
                },
                match: { "type": Type.BOOLEAN, "description": "Verdadero si el GRAN TOTAL de AL MENOS UNA moneda coincide (o es muy cercano) entre el documento base y los de soporte." },
                reasoning: { "type": Type.STRING, "description": "Explicación de la comparación de los grandes totales. Especifica qué moneda coincidió, por qué, o las discrepancias encontradas." }
            },
            required: ["base_doc_cif_values", "base_doc_totals", "support_docs_invoice_values", "support_docs_totals", "match", "reasoning"]
        }
    },
    required: ["fmm_number", "general_reasoning", "overall_match", "comparison_results", "articles_comparison", "cost_comparison"]
};

async function extractTextFromPdf(file: File): Promise<string> {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
    let fullText = '';
    const numPages = pdf.numPages;

    for (let i = 1; i <= numPages; i++) {
        updateUIState('loading', `Extrayendo texto de ${file.name} (página ${i}/${numPages})...`);
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        let pageText = textContent.items.map(item => ('str' in item ? (item as { str: string }).str : '')).join(' ');

        if (pageText.trim().length < 50) {
            try {
                console.log(`Page ${i} of ${file.name} has little text, attempting OCR...`);
                const worker = await getTesseractWorker();
                
                const viewport = page.getViewport({ scale: 2.0 });
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d', { willReadFrequently: true })!;
                canvas.height = viewport.height;
                canvas.width = viewport.width;

                await page.render({ canvasContext: context, viewport: viewport }).promise;
                
                const { data: { text: ocrText } } = await worker.recognize(canvas);
                
                if (ocrText.trim().length > pageText.trim().length) {
                    pageText = ocrText;
                }
            } catch (ocrError) {
                console.error(`OCR failed for page ${i} of ${file.name}:`, ocrError);
            }
        }
        fullText += pageText + '\n';
    }
    return fullText;
}

function normalizeFmmValue(v: string | number | null | undefined): string {
    if (v === null || v === undefined) return 'No encontrado';
    const s = String(v).trim();
    if (s === '' || s === '.') return 'No encontrado';
    return s;
}

// Si varias subpartidas coinciden en un campo, se reporta un único valor.
// Si difieren, se reporta una fila por subpartida para no perder información.
// Nota: los 4 ejemplos reales tienen una sola subpartida cada uno; el caso N>1
// con valores distintos no está probado con datos reales.
function summarizeSubpartidaField(
    fmm: FmmDocument,
    getValue: (sp: FmmSubpartida) => string | number | null | undefined
): string {
    const values = fmm.tran_subpartidas.map(sp => normalizeFmmValue(getValue(sp)));
    const distinct = Array.from(new Set(values));
    if (distinct.length <= 1) return distinct[0] ?? 'No encontrado';
    return fmm.tran_subpartidas.map((sp, i) => `${sp.codsp}: ${values[i]}`).join(' | ');
}

/**
 * ASUNCIÓN DE MONEDA/CIF — PENDIENTE DE CONFIRMAR CON EL EQUIPO DE NEGOCIO.
 * Se asume que fob/fletes/seguro/otrosgastos de cada subpartida están en USD, y
 * que 'tasacambio' es la tasa USD->COP de esa subpartida:
 *   CIF_USD = fob + fletes + seguro + otrosgastos
 *   CIF_COP = CIF_USD * tasacambio
 * Si el equipo confirma una convención distinta, ajustar SOLO esta función (y
 * computeBaseCifValues, que la consume).
 */
function computeSubpartidaCifUsd(sp: FmmSubpartida): number {
    return (sp.fob ?? 0) + (sp.fletes ?? 0) + (sp.seguro ?? 0) + (sp.otrosgastos ?? 0);
}

function computeBaseCifValues(fmm: FmmDocument): { subpartida: string; value_str: string; value_num: number; currency: string }[] {
    const values: { subpartida: string; value_str: string; value_num: number; currency: string }[] = [];
    fmm.tran_subpartidas.forEach(sp => {
        const cifUsd = computeSubpartidaCifUsd(sp);
        values.push({ subpartida: sp.codsp, value_str: cifUsd.toFixed(4), value_num: cifUsd, currency: 'USD' });
        if (sp.tasacambio) {
            const cifCop = cifUsd * sp.tasacambio;
            values.push({ subpartida: sp.codsp, value_str: cifCop.toFixed(4), value_num: cifCop, currency: 'COP' });
        }
    });
    return values;
}

function computeBaseCifTotals(cifValues: { value_num: number; currency: string }[]): { currency: string; total: number }[] {
    const totals: Record<string, number> = {};
    cifValues.forEach(v => { totals[v.currency] = (totals[v.currency] ?? 0) + v.value_num; });
    return Object.entries(totals).map(([currency, total]) => ({ currency, total }));
}

interface BaseDocPromptData {
    fmm_number: string;
    codigo_factura: string;
    documento_transporte: string;
    nit_tercero: string;
    nombre_tercero: string;
    dias_permanencia: number;
    comentario_general: string;
    origen: string;
    compra: string;
    destino: string;
    procedencia: string;
    bandera: string;
    tipo_transporte: string;
    tasa_cambio: string;
    subpartidas: {
        codigo_subpartida: string;
        peso_bruto: number;
        peso_neto: number;
        numero_bultos: number;
        unidad_medida_subpartida: string;
        cantidad_subpartida: number;
        fob: number;
        fletes: number;
        seguro: number;
        otros_gastos: number;
        tasa_cambio: number;
        articulos: {
            codigo_item: string;
            descripcion: string;
            cantidad: number;
            precio_unitario_usd: number;
            factor_conversion_nmconversion: number;
            unidad_medida: string;
        }[];
    }[];
    complementos_anexos: { anexo: string; documento: string; comentario: string; fecha: string }[];
}

function buildBaseDocPromptData(fmm: FmmDocument): BaseDocPromptData {
    return {
        fmm_number: String(fmm.nro_form),
        codigo_factura: normalizeFmmValue(fmm.codfactura),
        documento_transporte: normalizeFmmValue(fmm.coddoc_transp),
        nit_tercero: normalizeFmmValue(fmm.nitTercero),
        nombre_tercero: normalizeFmmValue(fmm.nombreTercero),
        dias_permanencia: fmm.dias ?? 0,
        comentario_general: normalizeFmmValue(fmm.dscomentario),
        origen: summarizeSubpartidaField(fmm, sp => sp.codorigen),
        compra: summarizeSubpartidaField(fmm, sp => sp.codcompra),
        destino: summarizeSubpartidaField(fmm, sp => sp.coddestino),
        procedencia: summarizeSubpartidaField(fmm, sp => sp.codprocedencia),
        bandera: summarizeSubpartidaField(fmm, sp => sp.codbandera),
        tipo_transporte: summarizeSubpartidaField(fmm, sp => sp.transporte),
        tasa_cambio: summarizeSubpartidaField(fmm, sp => sp.tasacambio),
        subpartidas: fmm.tran_subpartidas.map(sp => ({
            codigo_subpartida: sp.codsp,
            peso_bruto: sp.pesobruto,
            peso_neto: sp.pesoneto,
            numero_bultos: sp.nro_bultos,
            unidad_medida_subpartida: sp.umedida_sp,
            cantidad_subpartida: sp.cantidad_art,
            fob: sp.fob,
            fletes: sp.fletes,
            seguro: sp.seguro,
            otros_gastos: sp.otrosgastos,
            tasa_cambio: sp.tasacambio,
            articulos: sp.tran_articulos.map(a => ({
                codigo_item: a.coditem,
                descripcion: a.descripcion_item,
                cantidad: a.cantidad,
                precio_unitario_usd: a.ptprecio,
                factor_conversion_nmconversion: a.nmconversion,
                unidad_medida: a.unidad_medida,
            })),
        })),
        complementos_anexos: (fmm.complementos ?? []).map(c => ({
            anexo: normalizeFmmValue(c.dsanexo),
            documento: normalizeFmmValue(c.nmdoc),
            comentario: normalizeFmmValue(c.dscomentario),
            fecha: normalizeFmmValue(c.fecomple),
        })),
    };
}

function validateFmmDocument(data: any, sourceLabel: string): FmmDocument {
    if (!data || typeof data !== 'object') {
        throw new Error(`La respuesta de '${sourceLabel}' no tiene la estructura esperada de un FMM.`);
    }
    if (!Array.isArray(data.tran_subpartidas) || data.tran_subpartidas.length === 0) {
        throw new Error(`La respuesta de '${sourceLabel}' no contiene subpartidas ('tran_subpartidas'). Verifique el número de formulario.`);
    }
    if (data.nro_form === undefined || data.nro_form === null) {
        throw new Error(`La respuesta de '${sourceLabel}' no contiene un número de formulario ('nro_form').`);
    }
    return data as FmmDocument;
}

async function fetchFmmByNumber(formNumber: string): Promise<FmmDocument> {
    if (!FMM_API_TOKEN) {
        throw new Error('Falta configurar FMM_API_TOKEN. Defínalo en .env.local antes de compilar.');
    }

    const url = `${FMM_API_URL}?nmform_zf=${encodeURIComponent(formNumber)}`;
    let response: Response;
    try {
        response = await fetch(url, {
            method: 'GET',
            headers: { 'Token': FMM_API_TOKEN },
        });
    } catch (error) {
        console.error('Error de red al consultar el FMM:', error);
        throw new Error('No se pudo conectar con el servicio de búsqueda de FMM. Verifique su conexión e inténtelo de nuevo.');
    }

    if (response.status === 404) {
        throw new Error(`No se encontró ningún FMM con el número de formulario '${formNumber}'.`);
    }
    if (!response.ok) {
        throw new Error(`El servicio de búsqueda de FMM respondió con un error (HTTP ${response.status}).`);
    }

    let data: any;
    try {
        data = await response.json();
    } catch {
        throw new Error('La respuesta del servicio de búsqueda de FMM no es un JSON válido.');
    }

    return validateFmmDocument(data, `formulario ${formNumber}`);
}

async function runVerification(): Promise<any> {
    if (!baseDocumentJson || !baseDocumentFile) {
        throw new Error("Error interno: El documento base (JSON del FMM) no fue establecido antes de la verificación.");
    }
    if (supportDocuments.length === 0) {
        throw new Error("No se encontraron documentos de soporte en la carpeta cargada.");
    }

    try {
        updateUIState('loading', 'Extrayendo texto de los documentos de soporte...');
        const baseFileName = baseDocumentFile.name;
        const supportFileNames = supportDocuments.map(f => f.name).join(', ');

        const baseDocPromptData = buildBaseDocPromptData(baseDocumentJson);
        const baseCifValues = computeBaseCifValues(baseDocumentJson);
        const baseCifTotals = computeBaseCifTotals(baseCifValues);

        const supportDocTextPromises = supportDocuments.map(file => extractTextFromPdf(file));
        const supportDocsTexts = await Promise.all(supportDocTextPromises);
        const supportDocText = supportDocsTexts.join('\n\n--- Siguiente Documento de Soporte ---\n\n');

        updateUIState('loading', 'Analizando con IA...');

        // NOTE: Backticks inside this template literal are escaped (\`) to prevent parsing errors.
        const prompt = `
            Analiza exhaustivamente los siguientes documentos. Los nombres de los archivos se proporcionan para tu referencia.

            **Documentos Proporcionados:**
            - Documento Base (FMM, JSON estructurado): ${baseFileName}
            - Documentos de Soporte (PDF): ${supportFileNames}

            **Datos EXACTOS del Documento Base (FMM) — YA ESTRUCTURADOS:**
            Estos datos provienen de un JSON exportado directamente del sistema de origen. Son EXACTOS y
            NO requieren "reconstrucción" desde texto plano. Tu única tarea con ellos es COPIARLOS TAL CUAL
            como el lado "base" de cada comparación (\`fmm_number\`, \`base_value\` en \`comparison_results\`,
            el lado base de \`articles_comparison\`, \`base_doc_cif_values\` y \`base_doc_totals\`). NO los
            reinterpretes, NO los recalcules ni los busques en ningún texto: ya vienen calculados donde
            correspondía.

            \`\`\`json
            ${JSON.stringify(baseDocPromptData, null, 2)}
            \`\`\`

            **Valores CIF ya calculados por subpartida (COPIAR VERBATIM en 'base_doc_cif_values'):**
            \`\`\`json
            ${JSON.stringify(baseCifValues, null, 2)}
            \`\`\`

            **Grandes totales del documento base ya calculados (COPIAR VERBATIM en 'base_doc_totals'):**
            \`\`\`json
            ${JSON.stringify(baseCifTotals, null, 2)}
            \`\`\`

            **Complementos/Anexos del FMM (contexto libre):** NO se comparan campo a campo, pero pueden
            contener versiones alternativas o más limpias de números de factura, documento de transporte,
            contenedor, etc. Úsalos SOLO para desambiguar tu búsqueda en los documentos de soporte,
            mencionando en \`reasoning\` si encontraste ahí una referencia relacionada que no coincide
            textualmente con \`codigo_factura\`/\`documento_transporte\`.
            \`\`\`json
            ${JSON.stringify(baseDocPromptData.complementos_anexos, null, 2)}
            \`\`\`

            **Tarea:**
            Extrae de los documentos de soporte y compara contra los datos exactos del documento base:
            1.  **Número de Formulario de Movimiento de Mercancías (FMM) - ¡PRIORIDAD MÁXIMA!** Usa \`fmm_number\` tal cual.
            2.  Número de Documento de Transporte (B/L, AWB, CMR, etc.) — base: \`documento_transporte\`.
            3.  Número de Factura Comercial — base: \`codigo_factura\`.
            4.  Origen (País/ciudad donde se fabricó la mercancía) — base: \`origen\`.
            5.  Lugar de Compra (País/ciudad de la transacción comercial) — base: \`compra\`.
            6.  Destino (País/ciudad de entrega) — base: \`destino\`.
            7.  Procedencia (País/ciudad desde donde se despachó la mercancía) — base: \`procedencia\`.
            8.  Bandera (del medio de transporte, si aplica) — base: \`bandera\`.
            9.  Tipo de Transporte (Marítimo, Aéreo, Terrestre) — base: \`tipo_transporte\`.
            10. Tasa de Cambio — base: \`tasa_cambio\`.
            11. Lista de Artículos/Productos — base: \`subpartidas[].articulos[]\`.
            12. Comparación de Costos (CIF vs. Totales de Factura) — base: \`base_doc_cif_values\`/\`base_doc_totals\`.

            **Reglas de Análisis y Razonamiento (¡LEER CON ATENCIÓN! El orden indica la prioridad):**

            1.  **Aviso sobre la Extracción de Texto de los Documentos de Soporte (¡Regla Fundamental!):** El texto que recibes de los PDF de soporte es una versión "aplanada". Las columnas y tablas se convierten en una sola corriente de texto. Tu principal desafío es reconstruir inteligentemente las relaciones visuales a partir del texto desordenado. **NO asumas que una etiqueta y su valor están uno al lado del otro, a menos que una regla específica lo indique.** Esto NO aplica al documento base: sus datos ya vienen estructurados arriba.

            2.  **Análisis de Costos (CIF y Facturas) - ¡MÁXIMA PRIORIDAD!**
                Esta es tu tarea más crítica. Sigue estas sub-reglas para la comparación de costos:
                **Sub-Regla A: Valores CIF del Documento Base**
                - Los valores CIF por subpartida y los grandes totales del documento base YA fueron calculados y te fueron entregados arriba en \`base_doc_cif_values\` y \`base_doc_totals\`. CÓPIALOS VERBATIM en los campos homónimos de tu respuesta. NO los recalcules ni busques "Valor FOB/Fletes/Seguros/Otros Gastos/Valor CIF" en ningún texto — esa reconstrucción ya no es necesaria.

                **Sub-Regla B: Extracción de Totales de Facturas de Soporte - ¡MUY IMPORTANTE!**
                - **Clasificación Previa de Soportes para Costos (Regla Crítica):** Antes de extraer cualquier valor, tu primer paso es clasificar cada documento de soporte. Para el análisis de costos, considera **ÚNICAMENTE** documentos que son claramente facturas, remesas o listas de empaque con valores (es decir, una lista de artículos con precios). **IGNORA** y excluye categóricamente cualquier valor monetario encontrado en documentos que no cumplen este criterio, como contratos, cartas o acuerdos. Tu lista en \`support_docs_invoice_values\` solo debe contener valores de los documentos que clasificaste como válidos para costos.
                - Para cada archivo de factura de soporte VÁLIDO, tu objetivo es extraer **UN ÚNICO GRAN TOTAL** por cada moneda presente en la factura.
                - **IGNORA** categóricamente los valores de artículos individuales, subtotales parciales, costos de envío listados por separado, o cualquier otro monto que no sea el **VALOR TOTAL ANTES DE IMPUESTOS**.
                - **Regla del IVA (¡CRÍTICA!):** El valor a extraer DEBE ser el subtotal **ANTES** de aplicar impuestos como el IVA. Este valor suele estar etiquetado como "Subtotal", "Base Imponible", "Total Bruto" o similar. NO uses el "Total a Pagar" si este ya incluye el IVA. El valor después de IVA puede mencionarse en el \`reasoning\` de la comparación de costos si es relevante, pero el valor numérico para la comparación debe ser el de antes de IVA.
                - Si una única factura muestra un total en USD y otro en COP, debes extraer ambos como dos entradas separadas en \`support_docs_invoice_values\`, una para cada moneda, pero ambas asociadas al mismo \`source_doc\`.
                - El resultado debe ser una lista con un solo valor por factura por moneda. Por ejemplo, si hay 2 facturas en USD y 1 en COP, la lista tendrá 3 entradas.

                **Sub-Regla C: Cálculo, Conversión y Comparación**
                - \`base_doc_totals\` ya viene calculado (cópialo verbatim). Calcula únicamente \`support_docs_totals\` sumando todos los totales de factura de soporte por moneda.
                - **Regla de Conversión OBLIGATORIA:** Si hay una "Tasa de Cambio" disponible (\`tasa_cambio\`), DEBES usarla para enriquecer \`support_docs_totals\`. Para cada total en la lista, si existe la moneda opuesta (USD vs COP), calcula y añade su valor equivalente en los campos \`converted_total\` y \`converted_currency\`.
                - 'match' es \`true\` si los grandes totales coinciden (directamente o mediante conversión) entre \`base_doc_totals\` y \`support_docs_totals\`. Explica el resultado en \`reasoning\`.

            3.  **Regla Crítica para 'Número de Factura Comercial' (¡MÁXIMA ATENCIÓN!):**
                - **Objetivo:** Tu tarea es verificar que la(s) factura(s) comercial(es) del documento base se encuentren en los documentos de soporte.
                - **Base:** El valor base es \`codigo_factura\`, tal cual (puede venir con espacios o prefijos, ej. "REMSION SFI0739"). Repórtalo tal cual en \`base_value\`. Si no lo encuentras claramente en los documentos de soporte, revisa \`complementos_anexos\` (entradas con "FACTURA" en \`anexo\`) — allí puede haber una versión más limpia del mismo número (ej. "SFI0739"); si la encuentras y coincide con un documento de soporte, considera 'match: true' y explica en \`reasoning\` que se usó la referencia del complemento para desambiguar, sin sustituir el \`base_value\` reportado.
                - **Análisis y Coincidencia en Documentos de Soporte:**
                    - Busca el número de factura del documento base (y sus variantes de \`complementos_anexos\` si aplica) dentro de TODOS los documentos de soporte.
                    - En el campo 'support_value' de los resultados, reporta lo que SÍ encontraste.
                - **Regla de Coincidencia (match):** 'match: true' solo si encontraste una coincidencia razonable (directa o vía complemento) en los documentos de soporte; 'match: false' si no la encontraste.
                - **Regla de Razonamiento (reasoning):** Si 'match: false', DEBES especificar en 'reasoning' qué se buscó y por qué no se encontró.
                - **Importante:** Esta regla anula la "Regla de Coincidencia General" y la "Regla de Extracción para Otros Campos" para el campo "Número de Factura Comercial".

            4.  **Regla de Diferenciación Geográfica (Origen, Compra, Destino, Procedencia) - ¡ALTA PRIORIDAD!**
                - **Significado:** NO CONFUNDAS **Origen** (fabricación), **Compra** (transacción), **Procedencia** (despacho), **Destino** (entrega). Los valores base (\`origen\`, \`compra\`, \`destino\`, \`procedencia\`) ya vienen correctamente identificados y delimitados — cópialos tal cual, no los reinterpretes.
                - **Extracción en documentos de soporte:** Prefiere bloques verticales o alineación visual. Si no, busca la etiqueta exacta. Ten cuidado de no mezclar ciudades o países sin relación jerárquica directa al extraer del texto de soporte (ej. no combines "BRASIL-RIO GRANDE" con "Miami" si son campos distintos).
                - **Coincidencia:** SÓLO es \`match: true\` si el MISMO campo coincide (ej. Origen vs Origen). Si \`base.Destino\` coincide con \`support.Procedencia\`, es una DISCREPANCIA (\`match: false\`) y DEBES explicarlo en \`reasoning\`.

            5.  **Análisis Detallado de Artículos (Coincidencia Flexible):**
                Realiza una comparación granular para cada artículo de \`subpartidas[].articulos[]\` contra lo encontrado en los documentos de soporte.
                - **Coincidencia de Nombres (name_comparison):** ¡REGLA CRÍTICA! Debes ser flexible. El \`match\` debe ser \`true\` si los nombres son **semánticamente equivalentes**, aunque no sean idénticos textualmente. Tolera errores de OCR, orden de palabras, abreviaturas o palabras descriptivas adicionales. Por ejemplo, "TORNILLO ACERO INOX 3/4" DEBE coincidir con "Tornillo de Acero Inoxidable 3/4 Pulg.". Solo marca \`match: false\` si estás seguro de que son productos diferentes.
                - **Coincidencia de Cantidad (quantity_comparison):** Compara \`cantidad\` (base) contra la cantidad extraída del soporte. El \`match\` es \`true\` si las cantidades son idénticas.
                - **Coincidencia de Costos (cost_comparison):** ¡REGLA CRÍTICA! Tu tarea es realizar un análisis de costos DUAL para cada artículo, comparando tanto el **Costo Unitario** (base: \`precio_unitario_usd\`, en USD) como el **Costo Total** (base: \`cantidad × precio_unitario_usd\`) de forma independiente contra lo extraído del soporte.
                    - **Regla de Moneda para Artículos (¡MUY IMPORTANTE!):** Los valores base de artículos están en USD (\`precio_unitario_usd\`). Asume que los valores del soporte están en USD también, a menos que el documento indique explícitamente una moneda diferente.
                    - **Manejo de Valores Faltantes:** Si no encuentras un tipo de costo en el soporte, reporta sus valores como "No encontrado" dentro de su objeto respectivo (\`unit_cost\` o \`total_cost\`). NO omitas el objeto.
                    - **Coincidencia Individual:** El campo \`match\` dentro de \`unit_cost\` y \`total_cost\` se determina de forma independiente. Es \`true\` si los valores son idénticos, la diferencia porcentual es del 5% o menos, o si ambos son 'No encontrado'.
                    - **Coincidencia General (\`overall_match\`):** Es \`true\` solo si \`unit_cost.match\` y \`total_cost.match\` son ambos \`true\`. Si solo un tipo de costo está disponible, su coincidencia determina este valor.
                    - **Conversión de Moneda Obligatoria:** Si los costos del soporte están en una moneda diferente a USD y hay una \`tasa_cambio\` disponible, DEBES usarla para convertir antes de comparar.
                **Lógica OBLIGATORIA para Conversión de Unidades:**
                Cada artículo base en \`subpartidas[].articulos[]\` ya trae su propio \`factor_conversion_nmconversion\` (equivalente al NMCONVERSION del sistema de origen). Para cada artículo en 'articles_comparison', DEBES añadir el campo 'unit_conversion_analysis' SI Y SOLO SI la unidad de cantidad (\`unidad_medida\`) del artículo base NO coincide con la unidad extraída del documento de soporte.
                a.  Para cada artículo, extrae cantidad numérica y unidad para 'base_quantity'/'base_unit' (del JSON base) y 'support_quantity'/'support_unit' (del documento de soporte). Popula 'units_match' (booleano).
                b.  **Si 'units_match' es \`false\`:** Usa el \`factor_conversion_nmconversion\` de ese artículo como factor. Calcula: \`cantidad_convertida = support_quantity * factor_conversion_nmconversion\`. Popula 'conversion_applied: true', 'conversion_factor_used', y 'converted_support_quantity'. Compara 'cantidad_convertida' con 'base_quantity' (tolerancia del 5%) para determinar 'final_validation_status' ('✅ Coincide' o '❌ Cantidad incorrecta').
                c.  **Si 'units_match' es \`true\`:** OMITE el campo 'unit_conversion_analysis' por completo para ese artículo.
                d.  **Regla de Actualización de Coincidencia de Cantidad (¡MUY IMPORTANTE!):** Si el resultado en 'final_validation_status' es '✅ Coincide', DEBES establecer 'quantity_comparison.match' en \`true\` para ese artículo, y añadir un 'reasoning' a 'quantity_comparison' explicando que la coincidencia se logró después de la conversión de unidades.

            6.  **Regla Obligatoria para 'Tipo de Transporte' (¡IMPORTANTE!):**
                - **Base:** Usa \`tipo_transporte\` tal cual.
                - **Extracción en soporte:** Si no está explícitamente indicado en el documento de soporte, DEBES inferirlo a partir de pistas en el texto, como "B/L" (Bill of Lading) para "Marítimo", "AWB" (Air Waybill) para "Aéreo", o términos como "camión" o "carretera" para "Terrestre".
                - **Razonamiento OBLIGATORIO:** Para el campo 'Tipo de Transporte', el campo 'reasoning' es **OBLIGATORIO**. DEBES explicar siempre CÓMO determinaste el valor de soporte.

            7.  **Regla de Extracción para Otros Campos:**
                Para campos no cubiertos por reglas de alta prioridad, usa el método de "emparejamiento por orden" SOLO sobre el texto de los documentos de soporte: identifica bloques de etiquetas y valores, y emparéjalos secuencialmente.

            8.  **Regla de Coincidencia General:**
                - **Coincidencia Verdadera ('match: true'):** Los valores son idénticos/equivalentes, o ambos son 'No encontrado'.
                - **Coincidencia Falsa ('match: false'):** Los valores son diferentes, o uno tiene un valor y el otro es 'No encontrado'.
                - **Excepción:** No aplica a campos con reglas de coincidencia personalizadas (como Factura Comercial) o al Documento de Transporte si la regla de 'Origen Nacional' se activa.

            9.  **Regla de Negocio Obligatoria - Origen Nacional (Colombia):**
                - **SI** el 'Origen' base es 'COLOMBIA' o una ubicación dentro de Colombia, el campo 'Número de Documento de Transporte' DEBE tener 'match: true' y el 'reasoning' debe ser "No obligatorio para origen nacional (Colombia)", ignorando cualquier valor extraído del soporte.
                - **DE LO CONTRARIO (si el origen NO es Colombia):** Esta regla especial NO aplica. DEBES buscar y comparar el 'Número de Documento de Transporte' (\`documento_transporte\`) como harías con cualquier otro campo, siguiendo las reglas generales (Reglas 7 y 8).

            10. **Regla Geográfica - Coincidencia Jerárquica:**
                Considera 'match: true' si un valor es una ciudad y el otro es el país que la contiene (ej. 'Origen: COLOMBIA' y 'Origen: Cartagena'). Cuando apliques esta regla, DEBES justificarlo en 'reasoning'.

            11. **Tasa de Cambio (Solo Documento Base):**
                Usa \`tasa_cambio\` tal cual. Rellena un item en 'comparison_results' con ese \`base_value\`. 'support_value' debe ser "No encontrado" y 'match' debe ser 'true'.

            12. **Resumen y Resultado Final:**
                Proporciona un resumen general y determina el 'overall_match'.

            **Formato de Respuesta:**
            Proporciona tu análisis completo en el formato JSON especificado.

            **Contenido de los Documentos de Soporte (agregados):**
            ---
            ${supportDocText}
            ---
        `;

        console.log("Estimando tokens de entrada...");
        try {
            const { totalTokens } = await ai.models.countTokens({
                model: "gemini-3.6-flash",
                contents: prompt,
            });
            console.log(`Tokens de entrada (estimados): ${totalTokens}`);
        } catch(e) {
            console.warn("No se pudo estimar el número de tokens de entrada.", e);
        }

        const MAX_RETRIES = 4;
        let lastError: unknown;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                if (attempt > 1) {
                    const msg = lastError instanceof Error ? lastError.message : '';
                    const retryMatch = msg.match(/retry in (\d+(?:\.\d+)?)s/i);
                    const waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : attempt * 20;
                    updateUIState('loading', `Modelo con alta demanda. Reintentando (${attempt}/${MAX_RETRIES}) en ${waitSec}s...`);
                    await new Promise(resolve => setTimeout(resolve, waitSec * 1000));
                }

                updateUIState('loading', `Analizando con IA (intento ${attempt}/${MAX_RETRIES})...`);

                const response = await ai.models.generateContent({
                    model: "gemini-3.6-flash",
                    contents: prompt,
                    config: {
                        responseMimeType: "application/json",
                        responseSchema: responseSchema,
                    },
                });

                if (response.usageMetadata) {
                    console.group("Uso de Tokens (Respuesta de API)");
                    console.log(`Tokens de Entrada (real): ${response.usageMetadata.promptTokenCount}`);
                    console.log(`Tokens de Salida: ${response.usageMetadata.candidatesTokenCount}`);
                    console.log(`Tokens Totales: ${response.usageMetadata.totalTokenCount}`);
                    console.groupEnd();
                }

                const responseText = response.text;
                if (!responseText) {
                    throw new Error('La IA no retornó una respuesta de texto. Intente nuevamente.');
                }
                const result = JSON.parse(responseText);
                return result;

            } catch (error) {
                lastError = error;
                const msg = error instanceof Error ? error.message : String(error);
                const isRetriable = msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand') || msg.includes('retry');
                console.warn(`Intento ${attempt} fallido:`, msg);
                if (!isRetriable || attempt === MAX_RETRIES) break;
            }
        }

        console.error("Error during verification after retries:", lastError);
        const detail = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(`Error al contactar la IA: ${detail}`);

    } catch(e) {
        throw e;
    }
}

function updateUIState(state: 'initial' | 'loading' | 'success' | 'error', message?: string) {
    let content = '';
    switch (state) {
        case 'loading':
            content = `
                <div class="status-state">
                    <div class="spinner-large" aria-hidden="true"></div>
                    <h2>${message || 'Analizando documentos...'}</h2>
                    <p>Este proceso puede tardar unos minutos. Por favor, no cierre esta ventana.</p>
                </div>`;
            break;
        case 'success':
            content = `
                <div class="status-state">
                     <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="success-icon"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                    <h2>Análisis Finalizado</h2>
                    <p>${message}</p>
                </div>`;
            break;
        case 'error':
            content = `
                 <div class="status-state">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="error-icon"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                    <h2>Error en el Análisis</h2>
                    <p>${message}</p>
                </div>`;
            break;
        case 'initial':
        default:
             content = `
                <div class="initial-state">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="feather feather-file-text"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                    <h2>Listo para el Análisis</h2>
                    <p>Cargue el FMM (JSON) y la carpeta de documentos de soporte para comenzar.</p>
                </div>`;
            break;
    }
    resultContainer.innerHTML = content;
}

function collectDiscrepancies(result: any): any[] {
    const discrepancies: any[] = [];

    // 1. General fields
    if (result.comparison_results) {
        result.comparison_results.forEach((item: any) => {
            const fieldNameLower = item.field_name.toLowerCase();
            // The FMM is an identifier, not a value to be compared for discrepancies.
            // Exchange rate is also informational.
            if (!item.match && !fieldNameLower.includes("formulario de movimiento") && !fieldNameLower.includes("tasa de cambio")) {
                discrepancies.push({
                    type: 'Campo General',
                    title: item.field_name,
                    base_value: item.base_value,
                    support_value: item.support_value,
                    reasoning: item.reasoning
                });
            }
        });
    }

    // 2. Cost totals
    if (result.cost_comparison && !result.cost_comparison.match) {
         discrepancies.push({
            type: 'Costos Totales',
            title: 'Discrepancia en Totales Generales',
            base_value: 'Ver detalles en la sección de Análisis de Costos.', // Keep it simple
            support_value: 'Ver detalles en la sección de Análisis de Costos.',
            reasoning: result.cost_comparison.reasoning
        });
    }

    // 3. Articles
    if (result.articles_comparison) {
        result.articles_comparison.forEach((item: any) => {
            const articleErrors: any[] = [];
            if (!item.name_comparison.match) {
                articleErrors.push({
                    aspect: 'Nombre',
                    base_value: item.name_comparison.base_value,
                    support_value: item.name_comparison.support_value,
                });
            }
            if (!item.quantity_comparison.match) {
                articleErrors.push({
                    aspect: 'Cantidad',
                    base_value: item.quantity_comparison.base_value,
                    support_value: item.quantity_comparison.support_value,
                });
            }
            if (item.cost_comparison?.unit_cost && !item.cost_comparison.unit_cost.match) {
                articleErrors.push({
                    aspect: 'Costo Unitario',
                    base_value: item.cost_comparison.unit_cost.base_value,
                    support_value: item.cost_comparison.unit_cost.support_value,
                });
            }
            if (item.cost_comparison?.total_cost && !item.cost_comparison.total_cost.match) {
                articleErrors.push({
                    aspect: 'Costo Total',
                    base_value: item.cost_comparison.total_cost.base_value,
                    support_value: item.cost_comparison.total_cost.support_value,
                });
            }

            if(item.unit_conversion_analysis) {
                const status = item.unit_conversion_analysis.final_validation_status || '';
                if (status.includes('❌') || status.includes('⚠️')) {
                    articleErrors.push({
                        aspect: 'Conversión de Unidad',
                        base_value: `${item.unit_conversion_analysis.base_quantity} ${item.unit_conversion_analysis.base_unit}`,
                        support_value: `${item.unit_conversion_analysis.support_quantity} ${item.unit_conversion_analysis.support_unit}`,
                        reasoning: status,
                    });
                }
            }
            
            if (articleErrors.length > 0) {
                discrepancies.push({
                    type: 'Artículo',
                    title: item.item_description,
                    details: articleErrors, // Store sub-errors
                    reasoning: item.reasoning
                });
            }
        });
    }

    return discrepancies;
}


async function downloadFullReportAsPDF(analysisResult: any, baseDoc: File, supportDocs: File[]) {
    if (!analysisResult) {
        throw new Error("No hay resultados para generar el reporte.");
    }

    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const discrepancies = collectDiscrepancies(analysisResult);

    // --- PDF Styling and Helpers ---
    const FONT_TITLE = 22;
    const FONT_H1 = 18;
    const FONT_H2 = 14;
    const FONT_H3 = 11;
    const FONT_BODY = 10;
    const FONT_SMALL = 8;
    const MARGIN = 15;
    const PAGE_WIDTH = doc.internal.pageSize.getWidth();
    const PAGE_HEIGHT = doc.internal.pageSize.getHeight();
    const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
    let y = MARGIN;

    const COLOR = {
        PRIMARY_TEXT: '#0e2841',
        SECONDARY_TEXT: '#64748b',
        BORDER: '#e2e8f0',
        LIGHT_BG: '#f8fafc',
        SUCCESS: '#169e49',
        SUCCESS_BG: '#f0fdf4',
        DANGER: '#dc2626',
        DANGER_BG: '#fef2f2',
        PRIMARY_BRAND: '#15599a',
        NAVY_BRAND: '#0e2841',
        WHITE: '#FFFFFF',
        WARNING: '#f59e0b'
    };
    
    const fmmNumber = analysisResult?.fmm_number || 'N/A';
    const overallMatch = analysisResult?.overall_match;

    const resetY = () => { y = MARGIN + 10; };

    const checkPageBreak = (neededHeight = 20) => {
        if (y + neededHeight > PAGE_HEIGHT - MARGIN) {
            doc.addPage();
            resetY();
        }
    };
    
    const addHeaderAndFooter = () => {
        const pageCount = (doc.internal as any).getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            if (i > 1) { // No header/footer on cover page
                doc.setFontSize(FONT_SMALL);
                doc.setTextColor(COLOR.SECONDARY_TEXT);
                
                // Header
                doc.text('Reporte de Análisis de Documentos', MARGIN, MARGIN - 2);
                doc.text(`FMM: ${fmmNumber}`, PAGE_WIDTH - MARGIN, MARGIN - 2, { align: 'right' });
                doc.setDrawColor(COLOR.BORDER);
                doc.line(MARGIN, MARGIN, PAGE_WIDTH - MARGIN, MARGIN);

                // Footer
                doc.text('Powered by GI Proyectos SAS', MARGIN, PAGE_HEIGHT - 10);
                doc.text(`Página ${i} de ${pageCount}`, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 10, { align: 'right' });
            }
        }
    };

    const addText = (text: string, size: number, options: any = {}) => {
        doc.setFontSize(size);
        const { fontStyle = 'normal', color = COLOR.PRIMARY_TEXT, x = MARGIN, lineSpacingFactor = 1.15, align = 'left', maxWidth = CONTENT_WIDTH } = options;
        
        const textToPrint = text || 'N/A';
        const splitText = doc.splitTextToSize(textToPrint, maxWidth);
        const textHeight = doc.getTextDimensions(splitText).h * lineSpacingFactor;
        checkPageBreak(textHeight);

        let textX = x;
        if (align === 'center') {
            textX = PAGE_WIDTH / 2;
        } else if (align === 'right') {
            textX = PAGE_WIDTH - MARGIN;
        }

        doc.setFont('helvetica', fontStyle);
        doc.setTextColor(color);
        doc.text(splitText, textX, y, { align, lineHeightFactor: lineSpacingFactor });
        
        y += textHeight;
    };
    
    // FIX: Explicitly type the 'color' parameter as a string to prevent incorrect type inference by TypeScript, which was causing a type mismatch error with the jsPDF library's setTextColor method.
    const addSectionHeader = (title: string, color: string = COLOR.PRIMARY_TEXT) => {
        checkPageBreak(20);
        y += 5;
        doc.setFontSize(FONT_H1);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(color);
        doc.text(title, MARGIN, y);
        y += 4;
        doc.setFillColor(color);
        doc.rect(MARGIN, y, CONTENT_WIDTH * 0.3, 1, 'F');
        y += 10;
    };
    
    const formatCurrency = (value: number | string, currency: 'USD' | 'COP' | string) => {
        if (typeof value === 'string' && (value.toLowerCase() === 'no encontrado' || value.toLowerCase() === 'n/a')) {
            return value;
        }
        const num = typeof value === 'string' ? parseFloat(value.replace(/,/g, '')) : value;
        if (isNaN(num)) return String(value);

        return new Intl.NumberFormat('es-CO', {
            style: 'currency',
            currency: currency,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(num);
    };

    // --- PDF Content Generation ---
    
    // 1. Cover Page
    doc.setFillColor(COLOR.NAVY_BRAND);
    doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, 'F');
    doc.setTextColor(COLOR.WHITE);
    
    y = PAGE_HEIGHT / 3;
    addText('Reporte de Análisis de Documentos', FONT_TITLE, { align: 'center', fontStyle: 'bold', maxWidth: CONTENT_WIDTH, color: COLOR.WHITE });
    y += 5;
    if (fmmNumber !== 'N/A' && fmmNumber.toLowerCase() !== 'no encontrado') {
        addText(`Formulario de Movimiento de Mercancías:`, FONT_H3, { align: 'center', color: COLOR.WHITE, opacity: 0.8 });
        y += 2;
        addText(`${fmmNumber}`, FONT_H2, { align: 'center', fontStyle: 'bold', color: COLOR.WHITE });
    }
    
    y += 20;
    const badgeText = overallMatch ? "DOCUMENTOS COINCIDEN" : "SE ENCONTRARON DISCREPANCIAS";
    const badgeBG = overallMatch ? COLOR.SUCCESS : COLOR.DANGER;
    const badgeTextColor = COLOR.WHITE;
    doc.setFontSize(FONT_H3);
    doc.setFont('helvetica', 'bold');
    const textDimensions = doc.getTextDimensions(badgeText);
    const badgeWidth = textDimensions.w + 20;
    const badgeHeight = textDimensions.h + 8;
    const badgeX = (PAGE_WIDTH - badgeWidth) / 2;
    doc.setFillColor(badgeBG);
    doc.roundedRect(badgeX, y, badgeWidth, badgeHeight, 5, 5, 'F');
    doc.setTextColor(badgeTextColor);
    doc.text(badgeText, PAGE_WIDTH / 2, y + badgeHeight / 2, { align: 'center', baseline: 'middle' });
    
    const generationDate = `Generado el: ${new Date().toLocaleString('es-CO')}`;
    y = PAGE_HEIGHT - MARGIN - 5;
    addText(generationDate, FONT_SMALL, { align: 'center', color: COLOR.WHITE, opacity: 0.7 });
    
    // 2. Summary & Discrepancies Page
    doc.addPage();
    resetY();

    addSectionHeader('Resumen de Documentos Procesados');
    checkPageBreak(40);
    autoTable(doc, {
        startY: y,
        head: [['Documento Base Identificado']],
        body: [[baseDoc.name]],
        theme: 'striped',
        headStyles: { fillColor: COLOR.PRIMARY_BRAND, textColor: COLOR.WHITE },
        styles: { fontSize: FONT_BODY },
        margin: { left: MARGIN, right: MARGIN }
    });
    y = (doc as any).lastAutoTable.finalY + 5;
    
    autoTable(doc, {
        startY: y,
        head: [[`Documentos de Soporte (${supportDocs.length})`]],
        body: supportDocs.map(d => [d.name]),
        theme: 'striped',
        headStyles: { fillColor: COLOR.SECONDARY_TEXT, textColor: COLOR.WHITE },
        styles: { fontSize: FONT_BODY },
        margin: { left: MARGIN, right: MARGIN }
    });
    y = (doc as any).lastAutoTable.finalY + 5;

    const exchangeRateField = analysisResult.comparison_results.find((item: any) => item.field_name.toLowerCase().includes('tasa de cambio'));
    if (fmmNumber !== 'N/A' || exchangeRateField) {
        addSectionHeader('Datos Clave Extraídos');
        checkPageBreak(25);
        const bodyData = [];
        if (fmmNumber !== 'N/A') {
            bodyData.push(['Número de Formulario (FMM)', fmmNumber]);
        }
        if (exchangeRateField) {
            bodyData.push(['Tasa de Cambio', exchangeRateField.base_value]);
        }
        autoTable(doc, {
            startY: y,
            body: bodyData,
            theme: 'plain',
            styles: { fontSize: FONT_BODY },
            columnStyles: { 0: { fontStyle: 'bold' } },
            margin: { left: MARGIN, right: MARGIN }
        });
        y = (doc as any).lastAutoTable.finalY + 10;
    }

    addSectionHeader('Resumen de la IA');
    addText(analysisResult.general_reasoning, FONT_BODY, { color: COLOR.SECONDARY_TEXT, lineSpacingFactor: 1.4 });
    y += 10;

    if (discrepancies.length > 0) {
        addSectionHeader(`Resumen de Discrepancias (${discrepancies.length})`, COLOR.DANGER);

        discrepancies.forEach(error => {
            const getTextHeight = (text: string, size: number, options: any = {}) => {
                doc.setFontSize(size);
                const { fontStyle = 'normal', lineSpacingFactor = 1.15, maxWidth = CONTENT_WIDTH - 8 } = options;
                doc.setFont('helvetica', fontStyle);
                const textToPrint = text || 'N/A';
                const splitText = doc.splitTextToSize(textToPrint, maxWidth);
                return doc.getTextDimensions(splitText).h * lineSpacingFactor;
            };
            
            let contentHeight = 18;
            const details: { text: string; size: number; options: any }[] = [];
            if (error.type === 'Artículo') {
                error.details.forEach((d: any) => {
                    details.push({ text: `• ${d.aspect}: Base (${d.base_value || 'N/A'}) vs Soporte (${d.support_value || 'N/A'})`, size: FONT_BODY, options: { x: MARGIN + 4, color: COLOR.SECONDARY_TEXT, maxWidth: CONTENT_WIDTH - 8 } });
                    if (d.reasoning) {
                        details.push({ text: `  └ Razón: ${d.reasoning}`, size: FONT_BODY, options: { fontStyle: 'italic', x: MARGIN + 8, color: COLOR.DANGER, maxWidth: CONTENT_WIDTH - 12 } });
                    }
                    details.push({ text: '', size: FONT_BODY, options: { fixedHeight: 2 } });
                });
            } else {
                details.push({ text: `• Doc. Base: ${error.base_value || 'N/A'}`, size: FONT_BODY, options: { x: MARGIN + 4, color: COLOR.SECONDARY_TEXT, maxWidth: CONTENT_WIDTH - 8 } });
                details.push({ text: `• Doc. Soporte: ${error.support_value || 'N/A'}`, size: FONT_BODY, options: { x: MARGIN + 4, color: COLOR.SECONDARY_TEXT, maxWidth: CONTENT_WIDTH - 8 } });
            }
            if (error.reasoning) {
                details.push({ text: '', size: FONT_BODY, options: { fixedHeight: 2 } });
                details.push({ text: `Razón de la IA: ${error.reasoning}`, size: FONT_BODY, options: { fontStyle: 'italic', x: MARGIN + 4, color: COLOR.DANGER, maxWidth: CONTENT_WIDTH - 8 } });
            }
            
            details.forEach(d => {
                contentHeight += d.options.fixedHeight || getTextHeight(d.text, d.size, d.options);
            });
            const cardHeight = contentHeight;

            checkPageBreak(cardHeight);
            const startY = y;

            doc.setDrawColor(COLOR.DANGER);
            doc.setFillColor(COLOR.DANGER_BG);
            doc.roundedRect(MARGIN, startY, CONTENT_WIDTH, cardHeight, 3, 3, 'FD');
            
            let currentY = startY;
            
            doc.setFontSize(FONT_SMALL);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(COLOR.DANGER);
            doc.text(`[ ${error.type.toUpperCase()} ]`, MARGIN + 4, currentY + 5);
            doc.setFontSize(FONT_H3);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(COLOR.PRIMARY_TEXT);
            doc.text(error.title, MARGIN + 4, currentY + 12);
            currentY += 18;

            details.forEach(d => {
                if (d.options.fixedHeight) {
                    currentY += d.options.fixedHeight;
                } else if (d.text) {
                    doc.setFontSize(d.size);
                    const { fontStyle = 'normal', color = COLOR.PRIMARY_TEXT, x = MARGIN, lineSpacingFactor = 1.15, maxWidth = CONTENT_WIDTH } = d.options;
                    doc.setFont('helvetica', fontStyle);
                    doc.setTextColor(color);
                    const splitText = doc.splitTextToSize(d.text, maxWidth);
                    doc.text(splitText, x, currentY, { lineHeightFactor: lineSpacingFactor });
                    currentY += doc.getTextDimensions(splitText).h * lineSpacingFactor;
                }
            });
            y = startY + cardHeight + 4;
        });
    }

    // 3. Detailed Comparison
    const fieldsToCompare = (analysisResult.comparison_results || []).filter((item: any) => {
        const fieldNameLower = item.field_name.toLowerCase();
        return !fieldNameLower.includes('formulario de movimiento') && !fieldNameLower.includes('tasa de cambio');
    });
    
    if (fieldsToCompare.length > 0) {
        doc.addPage();
        resetY();
        addSectionHeader('Análisis Detallado de Campos');
        
        fieldsToCompare.forEach((item: any) => {
            const getTextHeight = (text: string, size: number, options: any = {}) => {
                doc.setFontSize(size);
                const { fontStyle = 'normal', lineSpacingFactor = 1.15, maxWidth = CONTENT_WIDTH } = options;
                doc.setFont('helvetica', fontStyle);
                const splitText = doc.splitTextToSize(text || 'N/A', maxWidth);
                return doc.getTextDimensions(splitText).h * lineSpacingFactor;
            };

            let currentHeight = 15;
            currentHeight += getTextHeight('Doc. Base:', FONT_BODY, { maxWidth: CONTENT_WIDTH - 12 });
            currentHeight += getTextHeight(item.base_value, FONT_BODY, { maxWidth: CONTENT_WIDTH - 40 });
            currentHeight += 2;
            currentHeight += getTextHeight('Doc. Soporte:', FONT_BODY, { maxWidth: CONTENT_WIDTH - 12 });
            currentHeight += getTextHeight(item.support_value, FONT_BODY, { maxWidth: CONTENT_WIDTH - 40 });

            if (item.reasoning) {
                currentHeight += 4;
                currentHeight += getTextHeight(`Razón de la IA: ${item.reasoning}`, FONT_BODY, { fontStyle: 'italic', maxWidth: CONTENT_WIDTH - 12 });
            }
            
            const cardHeight = Math.max(currentHeight, 30) + 8;
            checkPageBreak(cardHeight + 4);
            
            const startY = y;
            const statusBarColor = item.match ? COLOR.SUCCESS : COLOR.DANGER;
            
            doc.setDrawColor(COLOR.BORDER);
            doc.setFillColor(COLOR.LIGHT_BG);
            doc.roundedRect(MARGIN, startY, CONTENT_WIDTH, cardHeight, 3, 3, 'FD');
            
            doc.setFillColor(statusBarColor);
            doc.rect(MARGIN, startY, 3, cardHeight, 'F');
            
            doc.setFontSize(FONT_H3);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(COLOR.PRIMARY_TEXT);
            doc.text(item.field_name, MARGIN + 8, startY + 7);

            y = startY + 15;
            
            addText(`Doc. Base:`, FONT_BODY, { fontStyle: 'bold', x: MARGIN + 8, maxWidth: CONTENT_WIDTH - 12 });
            addText(`${item.base_value}`, FONT_BODY, { color: COLOR.SECONDARY_TEXT, x: MARGIN + 35, maxWidth: CONTENT_WIDTH - 40 });
            y += 2;
            addText(`Doc. Soporte:`, FONT_BODY, { fontStyle: 'bold', x: MARGIN + 8, maxWidth: CONTENT_WIDTH - 12 });
            addText(`${item.support_value}`, FONT_BODY, { color: COLOR.SECONDARY_TEXT, x: MARGIN + 35, maxWidth: CONTENT_WIDTH - 40 });
            
            if (item.reasoning) {
                y += 4;
                addText(`Razón de la IA: ${item.reasoning}`, FONT_BODY, { fontStyle: 'italic', x: MARGIN + 8, maxWidth: CONTENT_WIDTH - 12, color: item.match ? COLOR.SECONDARY_TEXT : COLOR.DANGER });
            }
            
            y = startY + cardHeight + 4;
        });
    }


    // 4. Cost Comparison (Redesigned)
    doc.addPage();
    resetY();
    addSectionHeader('Análisis Detallado de Costos');
    const { cost_comparison } = analysisResult;
    
    if (cost_comparison) {
        checkPageBreak(40);
        addText('Valores CIF por Subpartida (Documento Base)', FONT_H2, { fontStyle: 'bold' });
        y += 2;
        autoTable(doc, {
            startY: y,
            head: [['Subpartida', 'Moneda', 'Valor Declarado']],
            body: cost_comparison.base_doc_cif_values?.map((c: any) => [c.subpartida, c.currency, c.value_str]) || [['No se encontraron datos', '', '']],
            theme: 'striped',
            headStyles: { fillColor: COLOR.PRIMARY_BRAND, textColor: COLOR.WHITE },
            styles: { fontSize: FONT_BODY, cellPadding: 2.5 },
            margin: { left: MARGIN, right: MARGIN }
        });
        y = (doc as any).lastAutoTable.finalY + 10;
        
        checkPageBreak(40);
        addText('Valores Totales (Facturas de Soporte)', FONT_H2, { fontStyle: 'bold' });
        y += 2;
        autoTable(doc, {
            startY: y, 
            head: [['Documento', 'Moneda', 'Valor Total']],
            body: cost_comparison.support_docs_invoice_values?.map((i:any) => [i.source_doc, i.currency, i.value_str]) || [['No se encontraron datos', '', '']],
            theme: 'grid', headStyles: { fillColor: COLOR.PRIMARY_BRAND, textColor: COLOR.WHITE },
            styles: { fontSize: FONT_BODY, cellPadding: 2.5 },
            margin: { left: MARGIN, right: MARGIN }
        });
        y = (doc as any).lastAutoTable.finalY + 15;

        addText('Comparación de Totales Consolidados', FONT_H2, { fontStyle: 'bold' });
        y+=2;
        
        const baseTotalsUSD = cost_comparison.base_doc_totals.find((t: any) => t.currency === 'USD');
        const baseTotalsCOP = cost_comparison.base_doc_totals.find((t: any) => t.currency === 'COP');
        const supportTotalsUSD = cost_comparison.support_docs_totals.find((t: any) => t.currency === 'USD');
        const supportTotalsCOP = cost_comparison.support_docs_totals.find((t: any) => t.currency === 'COP');
        
        const totalsBody = [
            {
                concept: 'Total USD',
                base: baseTotalsUSD,
                support: supportTotalsUSD,
                currency: 'USD'
            },
            {
                concept: 'Total COP',
                base: baseTotalsCOP,
                support: supportTotalsCOP,
                currency: 'COP'
            }
        ];

        autoTable(doc, {
            startY: y,
            head: [['Concepto', 'Total Documento Base', 'Total Documentos de Soporte']],
            // The text in the body is now a placeholder; we will do all the drawing in didDrawCell.
            body: totalsBody.map(row => [
                row.concept,
                row.base ? '' : 'N/A',
                row.support ? '' : 'N/A'
            ]),
            theme: 'grid',
            headStyles: { fillColor: COLOR.NAVY_BRAND, textColor: COLOR.WHITE, halign: 'center' },
            styles: { fontSize: FONT_BODY, cellPadding: 3, halign: 'right' },
            columnStyles: { 0: { fontStyle: 'bold', halign: 'left' } },
            margin: { left: MARGIN, right: MARGIN },
            didParseCell: (data) => {
                if (data.cell.section === 'body' && (data.column.index === 1 || data.column.index === 2)) {
                    const rowData = totalsBody[data.row.index];
                    const cellData = data.column.index === 1 ? rowData.base : rowData.support;
                    
                    // If a converted total exists, we need more vertical space for two lines.
                    if (cellData && cellData.converted_total) {
                        data.cell.styles.minCellHeight = 15; // Provide ample height for two lines.
                    }
                }
            },
            didDrawCell: (data) => {
                if (data.cell.section === 'body' && (data.column.index === 1 || data.column.index === 2)) {
                    const rowData = totalsBody[data.row.index];
                    const cellData = data.column.index === 1 ? rowData.base : rowData.support;

                    // If there's no data for this cell, we must manually draw 'N/A'
                    // because we are now passing empty strings to the body.
                    if (!cellData) {
                        const rightPadding = (data.cell.padding as any)('right');
                        const textX = data.cell.x + data.cell.width - rightPadding;
                        const cellCenterY = data.cell.y + data.cell.height / 2;
                        doc.setFontSize(FONT_BODY);
                        doc.setTextColor(COLOR.SECONDARY_TEXT);
                        doc.text('N/A', textX, cellCenterY, { align: 'right', baseline: 'middle' });
                        return;
                    }

                    const rightPadding = (data.cell.padding as any)('right');
                    const textX = data.cell.x + data.cell.width - rightPadding;
                    const cellCenterY = data.cell.y + data.cell.height / 2;
                    
                    const mainText = formatCurrency(cellData.total, cellData.currency);
                    
                    // If there is a converted value, we draw two separate lines.
                    if (cellData.converted_total && cellData.converted_currency) {
                        const convertedText = `(${formatCurrency(cellData.converted_total, cellData.converted_currency)})`;
                        
                        // Draw main text (top line), positioned slightly above center in the larger cell.
                        doc.setFontSize(FONT_BODY);
                        doc.setTextColor(COLOR.PRIMARY_TEXT);
                        doc.text(mainText, textX, cellCenterY - 2, { align: 'right' });

                        // Draw converted text (bottom line), positioned slightly below center.
                        doc.setFontSize(FONT_SMALL - 1);
                        doc.setTextColor(COLOR.SECONDARY_TEXT);
                        doc.text(convertedText, textX, cellCenterY + 4, { align: 'right' });
                    } else {
                        // If no converted value, just draw the main text, vertically centered.
                        doc.setFontSize(FONT_BODY);
                        doc.setTextColor(COLOR.PRIMARY_TEXT);
                        doc.text(mainText, textX, cellCenterY, { align: 'right', baseline: 'middle' });
                    }
                }
            }
        });
        y = (doc as any).lastAutoTable.finalY + 10;


        addText('Conclusión de la IA sobre Costos', FONT_H2, { fontStyle: 'bold' });
        y += 2;
        const conclusionColor = cost_comparison.match ? COLOR.SUCCESS : COLOR.DANGER;
        const conclusionBgColor = cost_comparison.match ? COLOR.SUCCESS_BG : COLOR.DANGER_BG;
        
        const reasoningText = `Razón: ${cost_comparison.reasoning || 'No se proporcionó razonamiento.'}`;
        const splitReasoning = doc.splitTextToSize(reasoningText, CONTENT_WIDTH - 20);
        const reasoningHeight = doc.getTextDimensions(splitReasoning).h * 1.2;

        checkPageBreak(reasoningHeight + 25);
        const startCardY = y;
        
        doc.setDrawColor(conclusionColor);
        doc.setFillColor(conclusionBgColor);
        doc.roundedRect(MARGIN, startCardY, CONTENT_WIDTH, reasoningHeight + 20, 3, 3, 'FD');

        doc.setFontSize(FONT_H3);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(conclusionColor);
        doc.text(`Resultado: ${cost_comparison.match ? 'COINCIDEN' : 'DISCREPANCIA'}`, MARGIN + 5, startCardY + 8);
        
        doc.setFontSize(FONT_BODY);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(COLOR.PRIMARY_TEXT);
        doc.text(splitReasoning, MARGIN + 5, startCardY + 18, { lineHeightFactor: 1.2 });
        
        y = startCardY + reasoningHeight + 25;
        
    } else {
        addText('No se encontró análisis de costos.', FONT_BODY, { color: COLOR.SECONDARY_TEXT });
    }
    
    // 5. Articles Comparison
    if (analysisResult.articles_comparison && analysisResult.articles_comparison.length > 0) {
        doc.addPage();
        resetY();
        addSectionHeader('Análisis de Artículos');
        
        checkPageBreak(30);

        const notesBody = [
            ['Validación de Costos', 'La validación se realizó únicamente con documentos de soporte identificados como facturas, remesas o listas de empaque con valores.'],
        ];

        autoTable(doc, {
            startY: y,
            body: notesBody,
            theme: 'grid',
            styles: { fontSize: FONT_SMALL, cellPadding: 2 },
            columnStyles: { 0: { fontStyle: 'bold', fillColor: COLOR.LIGHT_BG, cellWidth: 50 }, 1: { cellWidth: 'auto' } },
            margin: { left: MARGIN, right: MARGIN }
        });
        y = (doc as any).lastAutoTable.finalY + 10;


        analysisResult.articles_comparison.forEach((item: any) => {
            checkPageBreak(60);
            addText(item.item_description, FONT_H2, { fontStyle: 'bold', color: COLOR.PRIMARY_BRAND });
            y += 2;
            autoTable(doc, {
                startY: y,
                head: [['Aspecto', 'Valor Base', 'Valor Soporte', 'Coincide']],
                body: [
                    ['Nombre', item.name_comparison.base_value, item.name_comparison.support_value, item.name_comparison.match ? 'Sí' : 'No'],
                    ['Cantidad', item.quantity_comparison.base_value, item.quantity_comparison.support_value, item.quantity_comparison.match ? 'Sí' : 'No'],
                    ['Costo Unitario', item.cost_comparison.unit_cost.base_value, item.cost_comparison.unit_cost.support_value, item.cost_comparison.unit_cost.match ? 'Sí' : 'No'],
                    ['Costo Total', item.cost_comparison.total_cost.base_value, item.cost_comparison.total_cost.support_value, item.cost_comparison.total_cost.match ? 'Sí' : 'No'],
                ],
                theme: 'grid',
                headStyles: { fillColor: COLOR.PRIMARY_BRAND, textColor: COLOR.WHITE },
                styles: { fontSize: FONT_BODY, cellPadding: 2 },
                margin: { left: MARGIN, right: MARGIN },
                didDrawCell: (data) => {
                    if (data.column.index === 3 && data.cell.section === 'body') {
                        const isMatch = data.cell.text[0] === 'Sí';
                        doc.setFillColor(isMatch ? COLOR.SUCCESS_BG : COLOR.DANGER_BG);
                        doc.setTextColor(isMatch ? COLOR.SUCCESS : COLOR.DANGER);
                        doc.rect(data.cell.x, data.cell.y, data.cell.width, data.cell.height, 'F');
                        // FIX: Pass the first element of the text array to doc.text. While doc.text accepts a string array, TypeScript's overload resolution can fail with complex types from jspdf-autotable. Using data.cell.text[0] ensures a simple string is passed, resolving the type error.
                        doc.text(data.cell.text[0], data.cell.x + data.cell.width / 2, data.cell.y + data.cell.height / 2, {
                            align: 'center',
                            baseline: 'middle'
                        });
                    }
                }
            });
            y = (doc as any).lastAutoTable.finalY + 5;

            if (item.unit_conversion_analysis) {
                 checkPageBreak(20);
                 const conv = item.unit_conversion_analysis;
                 addText('Análisis de Conversión de Unidades', FONT_H3, { fontStyle: 'bold' });
                 const status = conv.final_validation_status || '';
                 const statusColor = status.includes('✅') ? COLOR.SUCCESS : (status.includes('❌') ? COLOR.DANGER : '#f59e0b');
                 addText(`Resultado: ${status}`, FONT_BODY, { fontStyle: 'italic', color: statusColor });
                 if (conv.conversion_applied) {
                     addText(`Cálculo: ${conv.support_quantity} ${conv.support_unit} × ${conv.conversion_factor_used} → ${conv.converted_support_quantity?.toFixed(2)} ${conv.base_unit}`, FONT_BODY, {color: COLOR.SECONDARY_TEXT});
                 }
                 y += 5;
            }
            y += 5;
        });
    }

    // --- Finalize and Save PDF ---
    addHeaderAndFooter();
    
    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const fileName = `resultado_validacion_${timestamp}.pdf`;
    
    doc.save(fileName);
}


function setFmmControlsDisabled(disabled: boolean) {
    fmmNumberInput.disabled = disabled;
    fmmSearchButton.disabled = disabled;
}

function resetApp() {
    fmmNumberInput.value = '';
    fmmSelectionPrompt.textContent = 'Escriba el número de formulario y presione Buscar';
    fmmSelectionPrompt.classList.remove('file-selected');

    folderInput.value = '';
    folderSelectionPrompt.textContent = 'Haga clic para seleccionar una carpeta';
    folderSelectionPrompt.classList.remove('file-selected');

    updateUIState('initial');

    baseDocumentJson = null;
    baseDocumentFile = null;
    supportDocuments = [];
    selectedSupportFiles = [];

    setFmmControlsDisabled(false);
    folderInput.disabled = false;
    clearButton.disabled = false;
}

async function searchFmm() {
    const formNumber = fmmNumberInput.value.trim();
    if (!formNumber) {
        updateUIState('error', 'Ingrese un número de formulario antes de buscar.');
        return;
    }

    setFmmControlsDisabled(true);
    clearButton.disabled = true;
    updateUIState('loading', `Buscando el formulario ${formNumber}...`);

    try {
        baseDocumentJson = await fetchFmmByNumber(formNumber);
        baseDocumentFile = new File(
            [JSON.stringify(baseDocumentJson)],
            `FMM-${formNumber}.json`,
            { type: 'application/json' }
        );

        fmmSelectionPrompt.textContent = `Formulario ${formNumber} encontrado.`;
        fmmSelectionPrompt.classList.add('file-selected');
        updateUIState('initial');

        await maybeStartAnalysis();
    } catch (error) {
        console.error('Error al buscar el FMM:', error);
        baseDocumentJson = null;
        baseDocumentFile = null;
        const errorMessage = error instanceof Error ? error.message : 'Ocurrió un error inesperado al buscar el formulario.';
        updateUIState('error', errorMessage);
    } finally {
        setFmmControlsDisabled(false);
        clearButton.disabled = false;
    }
}

async function maybeStartAnalysis() {
    if (!baseDocumentJson || !baseDocumentFile || selectedSupportFiles.length === 0) return;

    setFmmControlsDisabled(true);
    folderInput.disabled = true;
    clearButton.disabled = true;

    try {
        const pdfFiles = selectedSupportFiles.filter(file =>
            file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));

        if (pdfFiles.length === 0) {
            throw new Error('No se encontraron archivos PDF en la carpeta de documentos de soporte.');
        }
        supportDocuments = pdfFiles;

        const result = await runVerification();

        updateUIState('loading', 'Generando reporte PDF...');
        await downloadFullReportAsPDF(result, baseDocumentFile, supportDocuments);

        updateUIState('success', 'El análisis ha finalizado. El reporte PDF ha sido descargado.');

    } catch (error) {
        console.error("Error en el proceso principal:", error);
        const errorMessage = error instanceof Error ? error.message : "Ocurrió un error inesperado durante el análisis.";
        updateUIState('error', errorMessage);
    } finally {
        setFmmControlsDisabled(false);
        folderInput.disabled = false;
        clearButton.disabled = false;
    }
}

// Event Listeners
fmmSearchButton.addEventListener('click', () => {
    void searchFmm();
});

fmmNumberInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        void searchFmm();
    }
});

folderInput.addEventListener('change', () => {
    if (!folderInput.files || folderInput.files.length === 0) {
        updateUIState('error', 'No se detectaron archivos en la carpeta seleccionada. Asegúrese de seleccionar una carpeta con documentos y que el navegador tenga permisos para acceder a ella.');
        return;
    }
    selectedSupportFiles = Array.from(folderInput.files);
    folderSelectionPrompt.textContent = `${selectedSupportFiles.length} archivo(s) seleccionados`;
    folderSelectionPrompt.classList.add('file-selected');
    void maybeStartAnalysis();
});

clearButton.addEventListener('click', resetApp);

// Initial state
resetApp();
