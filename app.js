        // El Google Sheet / Apps Script pasa a ser un ESPEJO (best-effort). La
        // fuente de verdad ahora es Firestore (ver bloque FIREBASE más abajo).
        const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbzgyHwr-Zwrm8iinhx-NZk9Jk88GfAxOZk4gSRqgO34R7Yk2kHrY-K_hExIT5WMRZ0/exec";

        // ==================== FIREBASE / FIRESTORE (fuente de verdad) ====================
        // apiKey es un identificador PÚBLICO del proyecto (va en el cliente por diseño;
        // NO es un secreto). El acceso lo controlan las Reglas de Seguridad de Firestore.
        const FIREBASE = {
            projectId: "participacion-7e3e6",
            apiKey: "AIzaSyBdOuPcS4yhSYuL7qfSWul0eTc-muHgQ7I"
        };
        const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents`;
        // Mapeo tipo lógico de la app -> colección de Firestore
        const FS_COLL = { plan: 'PlanCompras', anexo: 'AnexoPresupuestal' };

        // ---- Conversión de valores Firestore <-> JS ----
        function fsValToJs(v) {
            if (!v) return '';
            if (v.nullValue !== undefined) return '';
            if (v.stringValue !== undefined) return v.stringValue;
            if (v.integerValue !== undefined) return Number(v.integerValue);
            if (v.doubleValue !== undefined) return Number(v.doubleValue);
            if (v.booleanValue !== undefined) return v.booleanValue;
            if (v.timestampValue !== undefined) return v.timestampValue;
            return '';
        }
        function fsJsToVal(v) {
            if (v === '' || v === null || v === undefined) return { nullValue: null };
            if (typeof v === 'boolean') return { booleanValue: v };
            if (typeof v === 'number' && Number.isFinite(v)) {
                return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
            }
            return { stringValue: String(v) };
        }
        function fsDocToObj(d) {
            const o = {};
            const f = d.fields || {};
            for (const k in f) o[k] = fsValToJs(f[k]);
            o.ID = d.name.split('/').pop(); // el id del documento manda como ID
            return o;
        }

        // ---- Lectura de toda una colección (paginada) ----
        async function fsGetAll(collection) {
            let docs = [], pageToken = '';
            do {
                const url = `${FS_BASE}/${collection}?key=${FIREBASE.apiKey}&pageSize=300` +
                            (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
                const r = await fetch(url);
                if (!r.ok) throw new Error(`Firestore GET ${collection} HTTP ${r.status}`);
                const j = await r.json();
                (j.documents || []).forEach(d => docs.push(fsDocToObj(d)));
                pageToken = j.nextPageToken || '';
            } while (pageToken);
            return docs;
        }

        // ---- Escritura / borrado de un documento ----
        async function fsUpsert(collection, id, record) {
            const fields = {};
            for (const k in record) fields[k] = fsJsToVal(record[k]);
            fields['ID'] = fsJsToVal(String(id)); // asegura el campo ID
            const url = `${FS_BASE}/${collection}/${encodeURIComponent(id)}?key=${FIREBASE.apiKey}`;
            const r = await fetch(url, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields })
            });
            if (!r.ok) throw new Error(`Firestore save HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
            return await r.json();
        }
        async function fsDelete(collection, id) {
            const url = `${FS_BASE}/${collection}/${encodeURIComponent(id)}?key=${FIREBASE.apiKey}`;
            const r = await fetch(url, { method: 'DELETE' });
            if (!r.ok && r.status !== 404) throw new Error(`Firestore delete HTTP ${r.status}`);
            return true;
        }

        // ---- Carga inicial: arma la MISMA forma que devolvía el Apps Script ----
        // (planData, anexoData, listas, mapaProySubse, mapasDependientes) para no
        // tocar el resto de la app. Las listas y los mapas se derivan en el cliente.
        async function fetchFirestoreData() {
            const [plan, anexo, listasRows, proySubseRows] = await Promise.all([
                fsGetAll(FS_COLL.plan),
                fsGetAll(FS_COLL.anexo),
                fsGetAll('Listas'),
                fsGetAll('Proy-Subse')
            ]);

            // Listas: reshape columnar (cada columna -> arreglo de valores únicos).
            // Firestore devuelve los docs ordenados por id ('row_1','row_10','row_2'...),
            // así que reordenamos por el número de fila original para conservar el orden
            // curado de la hoja en los desplegables del modal/datalists.
            const _rowNum = (r) => { const m = /(\d+)/.exec(String(r.ID || '')); return m ? Number(m[1]) : 0; };
            listasRows.sort((a, b) => _rowNum(a) - _rowNum(b));
            const listas = {};
            listasRows.forEach(row => {
                Object.keys(row).forEach(col => {
                    if (col === 'ID') return;
                    const v = row[col];
                    if (v === '' || v === null || v === undefined) return;
                    (listas[col] = listas[col] || []).push(v);
                });
            });
            Object.keys(listas).forEach(k => {
                listas[k] = Array.from(new Set(listas[k].map(x => String(x))));
            });

            // mapaProySubse: Proyecto -> Subsecretaría equivalente
            const mapaProySubse = {};
            proySubseRows.forEach(r => {
                const p = r['Proyecto'];
                const s = r['Subsecretaría Equivalente en Plan de Compras'];
                if (p !== '' && p !== null && p !== undefined && s) mapaProySubse[String(p)] = s;
            });

            // mapasDependientes: derivados del Anexo, agrupados por Proyecto
            const md = { ActividadMGA: {}, Detalle: {}, ProductoMGA: {} };
            const push = (obj, p, v) => {
                if (p === null || p === '' || p === undefined || v === null || v === '' || v === undefined) return;
                const k = String(p);
                (obj[k] = obj[k] || []);
                if (!obj[k].includes(v)) obj[k].push(v);
            };
            anexo.forEach(r => {
                push(md.ActividadMGA, r.Proyecto, r['ACTIVIDAD MGA']);
                push(md.Detalle, r.Proyecto, r['ACTIVIDADES DETALLADAS']);
                push(md.ProductoMGA, r.Proyecto, r['CÓDIGO PRODUCTO MGA']);
            });

            return { status: 'success', planData: plan, anexoData: anexo, listas, mapaProySubse, mapasDependientes: md };
        }

        // ---- Espejo best-effort hacia el Google Sheet (nunca bloquea ni rompe) ----
        function mirrorToSheet(payload) {
            try {
                let body;
                if (payload.action === 'delete') {
                    body = { action: 'delete', type: payload.type, id: payload.id, requestId: generateUUID() };
                } else {
                    const rec = Object.assign({}, payload.record);
                    Object.keys(rec).forEach(k => { if (k.endsWith('_formula')) delete rec[k]; });
                    quitarColumnasFormula(rec, payload.type);
                    body = { action: 'save', type: payload.type, record: rec, requestId: generateUUID() };
                }
                fetch(WEB_APP_URL, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
            } catch (e) { /* el espejo nunca debe afectar el flujo principal */ }
        }
        // ================================================================================

        let saveTimeoutId = null;
        let hasUnsavedChanges = false; 
        let isSaving = false; 
        let currentView = 'Plan'; 
        let appData = [];
        let anexoData = [];
        let planDeltas = { adds: [], updates: [], deletes: [] };
        let anexoDeltas = { adds: [], updates: [], deletes: [] };
        let historyStack = [];

        let activeColFiltersPlan = {}; 
        let activeColFiltersAnexo = {};
        let searchTimeoutId = null;
        let hasShownConnectionError = false;

        const noFilterCols = [];

        window.addEventListener('beforeunload', function (e) {
            if (hasUnsavedChanges || saveTimeoutId || isSaving) {
                e.preventDefault(); e.returnValue = 'Tienes cambios sin guardar.';
            }
        });

        function generateUUID() {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
            return 'temp-' + Math.random().toString(36).substr(2, 9);
        }

        const predefinedHeaders = [
            "Subsecretaría", "Tipo de Bien", "Necesidad", "Estudio Previo", "Objeto", "Modalidad", "Causal", 
            "Mes de Compra", "Duración del Proyecto", "Unidad de Tiempo", "Fecha Inicio Ejecución", "Valor Unitario", 
            "Proyecto", "Trasladar a Proyecto", "Tipo de Recurso", "Posición Presupuestaría", "Trasladar a Pospre", "Fondo", "Observación", "Indicador Plan de Dllo (Solo producto)", 
            "ACTIVIDAD MGA", "Actividad detallada", "Codigo producto MGA", "Codigo CPC", "ESTADO", "CDP", 
            "Contrato Marco", "RP", "Contratista", "Técnico", "Jurídico", "Logístico", "Supervisor Principal", 
            "Supervisor Suplente", "Apoyo a la Supervisión Técnico", "Apoyo a la Supervisión Financiero", "Apoyo a la Supervisión Jurídico"
        ];
        
        const anexoHeaders = [
            "Subsecretaría", "Proyecto", "CÓDIGO PRODUCTO MGA", "PRODUCTO MGA", "ACTIVIDAD MGA", "ACTIVIDADES DETALLADAS", 
            "UNIDAD DE MEDIDA", "CANTIDAD", "COSTO UNITARIO", "COSTO TOTAL", "Clasificador por objeto de gasto (POSPRE)", 
            "VALIDADOR ¿REQUIERE CPC?", "Clasificador CPC", "Validador sección CPC", "Reserva"
        ];
        
        // Arreglos dinámicos para visualización (Drag & Drop)
        let dynamicPlanHeaders = [...predefinedHeaders];
        let dynamicAnexoHeaders = [...anexoHeaders];

        const columnasMoneda = ["Valor Unitario", "COSTO UNITARIO", "COSTO TOTAL"];
        const columnasNumericas = ["Duración del Proyecto", "CANTIDAD"];
        const columnasFecha = ["Fecha Inicio Ejecución"];
        const columnasMixtas = ["CDP", "RP", "Contrato Marco", "Contratista"];

        // Columnas que en el sheets son fórmulas: nunca se envían desde la app
        // (las calcula el sheets a partir de Proyecto/Actividad detallada).
        const formulaColsPlan = ["Subsecretaría", "ACTIVIDAD MGA", "Codigo producto MGA", "Codigo CPC"];
        const formulaColsAnexo = [];

        // Columnas calculadas que el modal nunca deja editar pero que sí enviamos
        // al backend (el backend respeta cualquier fórmula que tenga el sheets).
        const calculadasReadonly = { plan: [], anexo: ["COSTO UNITARIO"] };

        // Columnas donde el usuario puede escribir una fórmula tipo =200+200
        // (decimales con coma). El valor se calcula localmente y al backend se le
        // envía el string con `=` para que lo guarde como fórmula real del sheets.
        const colsFormulaUsuario = { plan: ["Valor Unitario"], anexo: ["COSTO TOTAL"] };

        // Evalúa una fórmula simple del usuario: =200+200 / =100,5-50 / =1+2-3
        // Devuelve { ok, value, error }. Solo admite + y - y números (con , o . como decimal).
        function parsearFormulaUsuario(raw) {
            let s = String(raw || '').trim();
            if (!s || s.charAt(0) !== '=') return { ok: false, error: 'Falta "=" al inicio' };
            s = s.slice(1).replace(/\s+/g, '').replace(/,/g, '.');
            if (s === '') return { ok: false, error: 'Fórmula vacía' };
            if (!/^[-+]?(\d+(\.\d+)?)([-+]\d+(\.\d+)?)*$/.test(s)) {
                return { ok: false, error: 'Solo se permiten números, + y -' };
            }
            const tokens = s.match(/[-+]?\d+(\.\d+)?/g) || [];
            let total = 0;
            for (const t of tokens) {
                const n = Number(t);
                if (isNaN(n)) return { ok: false, error: 'Número inválido: ' + t };
                total += n;
            }
            return { ok: true, value: total };
        }

        // Permisos en el modal:
        // - Plan: solo Equipo de Contratación edita todo. Las subsecretarías
        //   correspondientes solo pueden tocar "Actividad detallada".
        // - Anexo: la subsecretaría correspondiente edita TODO, excepto
        //   Proyecto, Subsecretaría y COSTO UNITARIO (esta última es fórmula).
        const planEditableNonAdmin = ["Actividad detallada", "Indicador Plan de Dllo (Solo producto)"];
        const adminOnlyAnexo = ["Proyecto", "Subsecretaría"];

        // Quita del record los campos que el sheets calcula con fórmula,
        // para que el backend nunca los sobrescriba con un valor literal.
        function quitarColumnasFormula(record, tipo) {
            const fc = tipo === 'plan' ? formulaColsPlan : formulaColsAnexo;
            fc.forEach(c => { delete record[c]; });
            return record;
        }
        
        const dependenciasColumna = {
            "ACTIVIDAD MGA": "ActividadMGA", 
            "Actividad detallada": "Detalle", 
            "Codigo producto MGA": "ProductoMGA",
            "ACTIVIDADES DETALLADAS": "Detalle",
            "CÓDIGO PRODUCTO MGA": "ProductoMGA", 
            "PRODUCTO MGA": "ProductoMGA"
        };

        let listasDesplegables = {
            "Subsecretaría": [], 
            "Mes de Compra": ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"],
            "ESTADO": ["Planeación", "En Ejecución", "Suspendido", "Liquidado", "Cerrado"],
            "Unidad de Tiempo": ["D", "M", "A"], 
            "Tipo de Bien": ["Misional", "Generico", "Servicio", "Obra"],
            "Modalidad": ["Contratación Directa", "Licitación Pública", "Mínima Cuantía", "Concurso de Méritos", "Selección Abreviada", "Subasta Inversa"],
            "Causal": [], 
            "VALIDADOR ¿REQUIERE CPC?": ["SI", "NO"], 
            "Proyecto": [], 
            "Posición Presupuestaría": [],
            "Técnico": [],
            "Jurídico": [],
            "Logístico": [],
            "Supervisor Principal": [],
            "Supervisor Suplente": [],
            "Apoyo a la Supervisión Técnico": [],
            "Apoyo a la Supervisión Financiero": [],
            "Apoyo a la Supervisión Jurídico": [],
            "CDP": [],
            "RP": [],
            "Contrato Marco": [],
            "Contratista": [],
            "Reserva": ["SÍ", "NO"] 
        };

        let mapasDependientes = {}; 
        let mapaProySubse = {}; 

        const formatMoneda = (val) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(val);

        // ================= LÓGICA DE DRAG & DROP =================
        let draggedCol = null;
        let dragView = null;

        function handleDragStart(e, col, view) {
            if (currentRole !== 'Equipo de Contratación') return;
            draggedCol = col;
            dragView = view;
            e.dataTransfer.effectAllowed = 'move';
            e.target.classList.add('dragging');
            document.body.classList.add('is-dragging'); 
        }

        function handleDragOver(e) {
            if (currentRole !== 'Equipo de Contratación') return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            let targetTh = e.target.closest('th');
            if (targetTh && !targetTh.classList.contains('dragging')) {
                targetTh.classList.add('drag-over');
            }
        }

        function handleDragLeave(e) {
            if (currentRole !== 'Equipo de Contratación') return;
            let targetTh = e.target.closest('th');
            if (targetTh) {
                targetTh.classList.remove('drag-over');
            }
        }

        function handleDrop(e, targetCol, view) {
            if (currentRole !== 'Equipo de Contratación') return;
            e.preventDefault();
            document.body.classList.remove('is-dragging');
            document.querySelectorAll('.dragging, .drag-over').forEach(el => {
                el.classList.remove('dragging');
                el.classList.remove('drag-over');
            });
            
            if (dragView !== view || draggedCol === targetCol || !draggedCol) return;
            
            let headersArray = view === 'Plan' ? dynamicPlanHeaders : dynamicAnexoHeaders;
            let fromIndex = headersArray.indexOf(draggedCol);
            let toIndex = headersArray.indexOf(targetCol);
            
            if (fromIndex > -1 && toIndex > -1) {
                headersArray.splice(fromIndex, 1);
                headersArray.splice(toIndex, 0, draggedCol);
                view === 'Plan' ? renderTable() : renderAnexoTable();
            }
            draggedCol = null;
            dragView = null;
        }

        function handleDragEnd(e) {
            document.body.classList.remove('is-dragging');
            document.querySelectorAll('.dragging, .drag-over').forEach(el => {
                el.classList.remove('dragging');
                el.classList.remove('drag-over');
            });
            draggedCol = null;
            dragView = null;
        }
        // =========================================================

        function updateSaveStatus(status) {
            const s1 = document.getElementById('saveStatus1'); const s2 = document.getElementById('saveStatus2');
            let className = "status-badge", text = "";
            if (status === 'saving') { className += " status-saving"; text = "⏳ Guardando..."; } 
            else if (status === 'loading') { className += " status-loading"; text = "🔄 Sincronizando..."; }
            else if (status === 'saved') { className += " status-saved"; text = "✅ Sincronizado"; } 
            else if (status === 'error') { className += " status-error"; text = "❌ Error"; } 
            else if (status === 'warning') { className += " status-error"; text = "⚠️ Diferencias"; }
            if(s1) { s1.className = className; s1.innerText = text; }
            if(s2) { s2.className = className; s2.innerText = text; }
        }

        async function cargarDatosDesdeGoogle() {
            updateSaveStatus('loading');
            try {
                const result = await fetchFirestoreData();
                if (result.status === 'success') {
                    planDeltas = { adds: [], updates: [], deletes: [] }; anexoDeltas = { adds: [], updates: [], deletes: [] };
                    appData = result.planData || []; anexoData = result.anexoData || []; mapasDependientes = result.mapasDependientes || {};
                    mapaProySubse = result.mapaProySubse || {}; 
                    
                    if (result.listas) {
                        for (let key in result.listas) {
                            let normKey = key.trim().replace(/\s+/g, ' ');
                            let matched = Object.keys(listasDesplegables).find(k => k.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() === normKey.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase());
                            if (matched) listasDesplegables[matched] = result.listas[key].filter(Boolean);
                            else listasDesplegables[normKey] = result.listas[key].filter(Boolean);
                        }
                    }
                    
                    const datalistsDiv = document.getElementById('datalists') || document.createElement('div');
                    datalistsDiv.id = 'datalists';
                    datalistsDiv.innerHTML = '';
                    columnasMixtas.forEach(col => {
                        let opts = listasDesplegables[col] || [];
                        let dl = document.createElement('datalist');
                        dl.id = 'list-' + col.replace(/\s+/g, '');
                        opts.forEach(o => {
                            let opt = document.createElement('option');
                            opt.value = o;
                            dl.appendChild(opt);
                        });
                        datalistsDiv.appendChild(dl);
                    });
                    document.body.appendChild(datalistsDiv);

                    updateFilterOptions(); renderTable(); renderAnexoTable(); updateSaveStatus('saved');
                } else {
                    updateSaveStatus('error');
                    console.error("Error backend:", result.message);
                }
            } catch (error) { 
                updateSaveStatus('error'); 
                console.error("Error de conexión:", error);
            }
        }

        function triggerAutoSave() {
            if (currentRole === 'Invitado') return; 
            updateSaveStatus('saving'); hasUnsavedChanges = true; 
            if (saveTimeoutId) clearTimeout(saveTimeoutId);
            saveTimeoutId = setTimeout(() => { ejecutarGuardadoSilencioso(); }, 2500); 
        }

        async function ejecutarGuardadoSilencioso(intentos = 3) {
            if (isSaving) return; 

            if (planDeltas.adds.length === 0 && planDeltas.updates.length === 0 && planDeltas.deletes.length === 0 &&
                anexoDeltas.adds.length === 0 && anexoDeltas.updates.length === 0 && anexoDeltas.deletes.length === 0) {
                return;
            }
            
            isSaving = true; 

            try {
                const snapshot = {
                    plan: { adds: [...planDeltas.adds], updates: [...planDeltas.updates], deletes: [...planDeltas.deletes] },
                    anexo: { adds: [...anexoDeltas.adds], updates: [...anexoDeltas.updates], deletes: [...anexoDeltas.deletes] }
                };

                planDeltas = { adds: [], updates: [], deletes: [] }; 
                anexoDeltas = { adds: [], updates: [], deletes: [] };

                const payload = { action: 'validarYGuardarDeltas', requestId: generateUUID(), planDeltas: snapshot.plan, anexoDeltas: snapshot.anexo };

                for (let i = 0; i < intentos; i++) {
                    try {
                        const controller = new AbortController();
                        const fetchTimeout = setTimeout(() => controller.abort(), 8000); // ⏱️ Forzar fallo si se queda "pending" más de 8 segundos

                        const response = await fetch(WEB_APP_URL, { 
                            method: 'POST', 
                            body: JSON.stringify(payload),
                            signal: controller.signal 
                        });
                        
                        clearTimeout(fetchTimeout);
                        const result = await response.json();
                        
                        if (result.status === 'success' || result.status === 'warning' || result.status === 'duplicate') {
                            hasShownConnectionError = false;
                            updateSaveStatus('saved');
                            hasUnsavedChanges = false;
                            saveTimeoutId = null;
                            if (result.report) {
                                let ignorados = [
                                    ...(result.report.plan?.updatesIgnorados || []),
                                    ...(result.report.anexo?.updatesIgnorados || [])
                                ];
                                if (ignorados.length > 0) {
                                    mostrarNotificacion("⚠️ " + ignorados.length + " cambio(s) no se aplicaron porque las filas ya no existen.");
                                }
                                let dups = (result.report.plan?.addsDuplicados || 0) + (result.report.anexo?.addsDuplicados || 0);
                                if (dups > 0) {
                                    mostrarNotificacion("ℹ️ " + dups + " fila(s) ya existían y no se duplicaron.");
                                }
                            }
                            return;
                        }
                    } catch (error) { 
                        if (i < intentos - 1) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
                    }
                }
                
                planDeltas.adds.unshift(...snapshot.plan.adds); planDeltas.updates.unshift(...snapshot.plan.updates); planDeltas.deletes.unshift(...snapshot.plan.deletes);
                anexoDeltas.adds.unshift(...snapshot.anexo.adds); anexoDeltas.updates.unshift(...snapshot.anexo.updates); anexoDeltas.deletes.unshift(...snapshot.anexo.deletes);
                
                let dedup = (arr) => {
                    let seen = new Map();
                    for (let idx = arr.length - 1; idx >= 0; idx--) {
                        let key = arr[idx].id + '||' + arr[idx].field;
                        if (seen.has(key)) { arr.splice(idx, 1); }
                        else { seen.set(key, true); }
                    }
                };
                dedup(planDeltas.updates); 
                dedup(anexoDeltas.updates);
                
                updateSaveStatus('error'); hasUnsavedChanges = true; saveTimeoutId = null; 

                if (!hasShownConnectionError) {
                    document.getElementById('msgModalTitle').innerText = '❌ Error de Conexión';
                    document.getElementById('msgModalTitle').style.color = 'var(--danger)';
                    document.getElementById('msgModalBody').innerText = 'Tus últimos cambios no pudieron ser enviados a la base de datos.\n\nEsto suele ocurrir por bloqueos en la red institucional (Firewall) o caídas de internet.\n\n⚠️ IMPORTANTE: No cierres ni recargues la página (F5) o perderás lo que acabas de escribir. El sistema seguirá intentando guardarlo automáticamente en el fondo.';
                    document.getElementById('msgModal').style.display = 'flex';
                    hasShownConnectionError = true;
                }
            } finally {
                isSaving = false; 
                
                if (planDeltas.adds.length > 0 || planDeltas.updates.length > 0 || planDeltas.deletes.length > 0 ||
                    anexoDeltas.adds.length > 0 || anexoDeltas.updates.length > 0 || anexoDeltas.deletes.length > 0) {
                    triggerAutoSave(); 
                }
            }
        }

        // Atajo para el botón que agrupa por POSPRE + Actividad detallada
        function verDiferenciasDetalle() { return verDiferencias('pospre-actividad'); }

        // modo: 'pospre' (por defecto) agrupa solo por POSPRE.
        //       'pospre-actividad' agrupa por POSPRE + Actividad detallada concatenados.
        async function verDiferencias(modo) {
            modo = modo || 'pospre';
            const porActividad = (modo === 'pospre-actividad');
            let curPro = document.getElementById('filterProyectoAnexo').value;
            if(!curPro) {
                document.getElementById('msgModalTitle').innerText = 'Alerta';
                document.getElementById('msgModalTitle').style.color = 'var(--text-main)';
                document.getElementById('msgModalBody').innerText = 'Por favor, selecciona un proyecto de la lista para analizarlo.';
                document.getElementById('msgModal').style.display = 'flex';
                return;
            }

            let titleEl = document.getElementById('validationTitle');
            titleEl.innerText = "⏳ Consultando..."; titleEl.style.color = "var(--warning)";
            document.getElementById('validationErrors').style.padding = "15px";
            document.getElementById('validationErrors').innerText = "Conectando con la base de datos...";
            document.getElementById('validationModal').style.display = 'flex';

            // === Tabla dinámica calculada EN LA APP ===
            // Concilia Plan (suma de "Valor Unitario") vs Anexo (suma de "COSTO TOTAL").
            // La llave de agrupación depende del modo:
            //   'pospre'            -> POSPRE
            //   'pospre-actividad'  -> POSPRE || Actividad detallada
            // OJO: la columna de actividad se llama distinto en cada hoja:
            //   Plan  = "Actividad detallada"   Anexo = "ACTIVIDADES DETALLADAS"
            const SEP = ' ‖ ';
            const norm = (v) => String(v ?? '').trim();
            // Quita el prefijo de "formato texto" de Excel (´ ' ` ’) que traen los
            // POSPRE del Anexo (p.ej. "´23201010030302") y que el Plan no tiene.
            const cleanPospre = (v) => norm(v).replace(/^[´'`’]+/, '');
            // Versión canónica SOLO para emparejar llaves (no para mostrar): ignora
            // el prefijo de Excel, mayúsculas/minúsculas, tildes y espacios repetidos,
            // para que el mismo POSPRE/actividad empareje aunque se digitara distinto.
            const canon = (v) => cleanPospre(v)
                .toLocaleUpperCase('es')
                .normalize('NFD').replace(/[̀-ͯ]/g, '')
                .replace(/\s+/g, ' ');
            const planBy = {}, anexoBy = {}, grupoDe = {};
            appData.forEach(r => {
                if (String(r.Proyecto) !== String(curPro)) return;
                const posDisp = norm(r["Posición Presupuestaría"]) || "(Sin POSPRE)";
                const actDisp = norm(r["Actividad detallada"]) || "(Sin actividad)";
                const key = porActividad ? (canon(posDisp) + SEP + canon(actDisp)) : canon(posDisp);
                planBy[key] = (planBy[key] || 0) + (Number(r["Valor Unitario"]) || 0);
                if (!grupoDe[key]) grupoDe[key] = { pospre: posDisp, act: actDisp };
            });
            anexoData.forEach(r => {
                if (String(r.Proyecto) !== String(curPro)) return;
                const posDisp = norm(r["Clasificador por objeto de gasto (POSPRE)"]) || "(Sin POSPRE)";
                const actDisp = norm(r["ACTIVIDADES DETALLADAS"]) || "(Sin actividad)";
                const key = porActividad ? (canon(posDisp) + SEP + canon(actDisp)) : canon(posDisp);
                anexoBy[key] = (anexoBy[key] || 0) + (Number(r["COSTO TOTAL"]) || 0);
                if (!grupoDe[key]) grupoDe[key] = { pospre: posDisp, act: actDisp };
            });
            const keys = Array.from(new Set([...Object.keys(planBy), ...Object.keys(anexoBy)])).sort();
            const filas = [];
            keys.forEach(key => {
                const p = planBy[key] || 0, a = anexoBy[key] || 0, d = p - a;
                if (Math.abs(d) > 1) {
                    const info = grupoDe[key] || { pospre: key, act: "" };
                    if (porActividad) {
                        filas.push([info.pospre, info.act, formatMoneda(p), formatMoneda(a), formatMoneda(d)]);
                    } else {
                        filas.push([info.pospre, formatMoneda(p), formatMoneda(a), formatMoneda(d)]);
                    }
                }
            });

            const encabezados = porActividad
                ? ["POSPRE", "Actividad detallada", "Valor Plan", "Valor Anexo", "Diferencia"]
                : ["POSPRE", "Valor Plan", "Valor Anexo", "Diferencia"];
            const detalleTxt = porActividad ? "por POSPRE + Actividad detallada" : "por POSPRE";

            const errEl = document.getElementById('validationErrors');
            if (filas.length > 0) {
                titleEl.innerText = "⚠️ Diferencias encontradas (" + detalleTxt + ")"; titleEl.style.color = "var(--danger)";
                errEl.style.padding = "0";
                let tableHTML = '<table style="width: 100%; border-collapse: collapse; text-align: left; margin: 0; white-space: normal;">';
                tableHTML += '<thead><tr>';
                encabezados.forEach(enc => {
                    tableHTML += `<th style="background-color: #cbd5e1; padding: 12px 16px; border-bottom: 2px solid #94a3b8; border-right: 1px solid #94a3b8; color: #0f172a; font-weight: bold; position: sticky; top: 0; z-index: 30;">${escapeHtml(enc)}</th>`;
                });
                tableHTML += '</tr></thead><tbody>';
                filas.forEach(fila => {
                    tableHTML += '<tr style="border-bottom: 1px solid var(--border);">';
                    fila.forEach((celda, idx) => {
                        let isLast = idx === fila.length - 1;
                        let bgStyle = isLast ? 'background-color: #fee2e2; color: #dc2626; font-weight: bold;' : 'background-color: #ffffff; color: #334155;';
                        tableHTML += `<td style="padding: 10px 16px; border-right: 1px solid var(--border); ${bgStyle}">${escapeHtml(celda)}</td>`;
                    });
                    tableHTML += '</tr>';
                });
                tableHTML += '</tbody></table>';
                errEl.innerHTML = tableHTML;
            } else {
                titleEl.innerText = "✅ Todo cuadra perfectamente"; titleEl.style.color = "var(--success)";
                errEl.style.padding = "15px";
                errEl.innerHTML = "<span style='color: #059669; font-weight: 500;'>No se encontraron diferencias " + escapeHtml(detalleTxt) + " para este proyecto.</span>";
            }
        }

        function toYYYYMMDD(v) { 
            if(!v) return ""; 
            if(typeof v === 'number') {
                let d = new Date(Math.round((v - 25569) * 86400 * 1000));
                d = new Date(d.getTime() + d.getTimezoneOffset() * 60000);
                return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
            }
            if(typeof v === 'string' && v.match(/^\d{4}-\d{2}-\d{2}$/)) return v;
            let str = typeof v === 'string' && !v.includes('T') ? v + 'T12:00:00' : v;
            let d = new Date(str); 
            return isNaN(d.getTime()) ? String(v) : d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        }
        
        function toDDMMAAAA(v) { 
            let ymd = String(toYYYYMMDD(v)); 
            if(ymd.includes('-')){ 
                let p = ymd.split('-'); 
                return `${p[2]}/${p[1]}/${p[0]}`; 
            } 
            return v; 
        }

        function updateFilterOptions() {
            const p1 = new Set(), posprePlanSet = new Set();
            appData.forEach(r => {
                if(r.Proyecto) p1.add(String(r.Proyecto).trim());
                if(r["Posición Presupuestaría"]) posprePlanSet.add(String(r["Posición Presupuestaría"]).trim());
            });
            const selP = document.getElementById('filterProyecto'), selPosprePlan = document.getElementById('filterPosprePlan');
            // Preserva la selección actual antes de reescribir las opciones
            const prevP = selP ? selP.value : '';
            const prevPospre = selPosprePlan ? selPosprePlan.value : '';
            if(selP) {
                const opts = Array.from(p1).sort();
                selP.innerHTML = '<option value="">Todos los Proyectos</option>' + opts.map(p => `<option value="${p}">${p}</option>`).join('');
                if (prevP && opts.includes(prevP)) selP.value = prevP;
            }
            if(selPosprePlan) {
                const opts = Array.from(posprePlanSet).sort();
                selPosprePlan.innerHTML = '<option value="">Todos los POSPRE</option>' + opts.map(p => `<option value="${p}">${p}</option>`).join('');
                if (prevPospre && opts.includes(prevPospre)) selPosprePlan.value = prevPospre;
            }
            
            const p2 = new Set(); anexoData.forEach(r => { if(r.Proyecto) p2.add(String(r.Proyecto).trim()); });
            const selPA = document.getElementById('filterProyectoAnexo');
            if(selPA) {
                const prevPA = selPA.value;
                let opts = Array.from(p2).sort();
                selPA.innerHTML = opts.map(p => `<option value="${p}">${p}</option>`).join('');
                if (prevPA && opts.includes(prevPA)) selPA.value = prevPA;
                else if(opts.length > 0 && !selPA.value) selPA.value = opts[0];
                
                let fP = selPA.value;
                let aSet = new Set();
                let pSet = new Set();
                anexoData.forEach(r => {
                    if(String(r.Proyecto) === String(fP)) {
                        if(r["ACTIVIDAD MGA"]) aSet.add(String(r["ACTIVIDAD MGA"]).trim());
                        if(r["Clasificador por objeto de gasto (POSPRE)"]) pSet.add(String(r["Clasificador por objeto de gasto (POSPRE)"]).trim());
                    }
                });
                let selA = document.getElementById('filterActividadMGA');
                if (selA) {
                    let currA = selA.value;
                    selA.innerHTML = '<option value="">Todas las Actividades</option>' + Array.from(aSet).sort().map(a => `<option value="${a}">${a}</option>`).join('');
                    if(Array.from(aSet).includes(currA)) selA.value = currA;
                }
                let selPospre = document.getElementById('filterPospreAnexo');
                if (selPospre) {
                    let currP = selPospre.value;
                    selPospre.innerHTML = '<option value="">Todos los POSPRE</option>' + Array.from(pSet).sort().map(p => `<option value="${p}">${p}</option>`).join('');
                    if(Array.from(pSet).includes(currP)) selPospre.value = currP;
                }
            }
        }

        let sortCol = null; let sortAsc = true;
        function toggleSort(col, isAnexo = false) {
            if (sortCol === col) sortAsc = !sortAsc; else { sortCol = col; sortAsc = true; }
            let arr = isAnexo ? anexoData : appData;
            arr.sort((a,b) => {
                let vA = a[col]||"", vB = b[col]||"";
                if(columnasMoneda.includes(col) || columnasNumericas.includes(col)) { vA=Number(vA); vB=Number(vB); }
                else { vA = String(vA).toLowerCase(); vB = String(vB).toLowerCase(); }
                return sortAsc ? (vA > vB ? 1 : -1) : (vA < vB ? 1 : -1);
            });
            isAnexo ? renderAnexoTable() : renderTable();
        }

        function debounceSearch(view) {
            clearTimeout(searchTimeoutId);
            searchTimeoutId = setTimeout(() => {
                if (view === 'Plan') renderTable();
                else renderAnexoTable();
            }, 300);
        }

        function searchFilterPopup() {
            let input = document.getElementById('filterPopupSearch').value.toLowerCase();
            let labels = document.getElementById('filterPopupList').querySelectorAll('label');
            
            labels.forEach(label => {
                let text = label.textContent || label.innerText;
                if (text.toLowerCase().indexOf(input) > -1) {
                    label.style.display = 'block';
                } else {
                    label.style.display = 'none';
                }
            });
        }

        function limpiarFiltros(view) {
            if (view === 'Plan') {
                if(document.getElementById('filterProyecto')) document.getElementById('filterProyecto').value = "";
                if(document.getElementById('searchObjeto')) document.getElementById('searchObjeto').value = "";
                activeColFiltersPlan = {};
                onProyectoPlanChange(); 
            } else {
                if(document.getElementById('filterActividadMGA')) document.getElementById('filterActividadMGA').value = "";
                if(document.getElementById('filterPospreAnexo')) document.getElementById('filterPospreAnexo').value = "";
                activeColFiltersAnexo = {};
                renderAnexoTable();
            }
        }

        let currentFilterContext = { view: '', col: '' };

        function openColumnFilter(e, col, view) {
            e.stopPropagation();
            currentFilterContext = { view, col };
            let data = view === 'Plan' ? appData : anexoData;
            let activeFilters = view === 'Plan' ? activeColFiltersPlan : activeColFiltersAnexo;

            let fP = view === 'Plan' ? document.getElementById('filterProyecto').value : document.getElementById('filterProyectoAnexo').value;
            let fPospre = view === 'Plan' ? (document.getElementById('filterPosprePlan')?.value || "") : (document.getElementById('filterPospreAnexo')?.value || "");
            let fA = view === 'Anexo' ? (document.getElementById('filterActividadMGA')?.value || "") : "";
            let sObjeto = view === 'Plan' ? (document.getElementById('searchObjeto')?.value.toLowerCase() || "") : "";

            let filteredData = data.filter(r => {
                if (fP && String(r.Proyecto) !== String(fP)) return false;
                if (view === 'Plan' && fPospre && String(r["Posición Presupuestaría"]) !== String(fPospre)) return false;
                if (view === 'Anexo' && fPospre && String(r["Clasificador por objeto de gasto (POSPRE)"]) !== String(fPospre)) return false;
                if (view === 'Anexo' && fA && String(r["ACTIVIDAD MGA"]) !== String(fA)) return false;
                if (view === 'Plan' && sObjeto) {
                    let obj = String(r["Objeto"] || "").toLowerCase();
                    if (!obj.includes(sObjeto)) return false;
                }

                for (let c in activeFilters) {
                    if (c !== col && activeFilters[c] && activeFilters[c].length > 0) {
                        if (!activeFilters[c].includes(String(r[c] || "").trim())) return false;
                    }
                }
                return true;
            });

            let uniqueValues = new Set();
            filteredData.forEach(r => uniqueValues.add(String(r[col] || "").trim()));
            let sortedVals = Array.from(uniqueValues).sort();

            let listHTML = '';
            let currentSelected = activeFilters[col] || sortedVals;

            sortedVals.forEach(val => {
                let isChecked = currentSelected.includes(val) ? 'checked' : '';
                let displayVal = val === "" ? "(Vacío)" : val;
                listHTML += `<label style="display:block; margin-bottom:6px; cursor:pointer;"><input type="checkbox" class="col-filter-cb" value="${val}" ${isChecked} style="margin-right:6px;"> ${displayVal}</label>`;
            });

            document.getElementById('filterPopupTitle').innerText = col;
            document.getElementById('filterPopupList').innerHTML = listHTML;
            
            let searchInput = document.getElementById('filterPopupSearch');
            if(searchInput) searchInput.value = '';

            let popup = document.getElementById('columnFilterPopup');
            popup.style.display = 'block';

            let rect = e.target.getBoundingClientRect();
            popup.style.top = (rect.bottom + window.scrollY + 5) + 'px';
            popup.style.left = (rect.left + window.scrollX - 50) + 'px'; 
        }

        function closeColumnFilter() { document.getElementById('columnFilterPopup').style.display = 'none'; }
        
        function selectAllFilters(check) { 
            let searchInput = document.getElementById('filterPopupSearch');
            let hasSearch = searchInput && searchInput.value.trim() !== '';
            
            document.querySelectorAll('.col-filter-cb').forEach(cb => {
                let isVisible = cb.closest('label').style.display !== 'none';
                if (hasSearch) {
                    if (isVisible) cb.checked = check;
                } else {
                    cb.checked = check;
                }
            }); 
        }

        function applyColumnFilter() {
            let selected = [];
            let searchInput = document.getElementById('filterPopupSearch');
            let hasSearch = searchInput && searchInput.value.trim() !== '';
            let allCbs = document.querySelectorAll('.col-filter-cb');
            
            allCbs.forEach(cb => {
                let isVisible = cb.closest('label').style.display !== 'none';
                if (hasSearch) {
                    if (cb.checked && isVisible) selected.push(cb.value);
                } else {
                    if (cb.checked) selected.push(cb.value);
                }
            });

            let col = currentFilterContext.col;
            let activeFilters = currentFilterContext.view === 'Plan' ? activeColFiltersPlan : activeColFiltersAnexo;
            
            if (!hasSearch && (selected.length === allCbs.length || selected.length === 0)) {
                delete activeFilters[col]; 
            } else if (hasSearch && selected.length === 0) {
                activeFilters[col] = ["__NO_MATCH__"]; 
            } else {
                activeFilters[col] = selected;
            }

            closeColumnFilter();
            currentFilterContext.view === 'Plan' ? renderTable() : renderAnexoTable();
        }

        document.addEventListener('click', function(e) {
            let popup = document.getElementById('columnFilterPopup');
            if (popup.style.display === 'block' && !popup.contains(e.target) && !e.target.classList.contains('filter-icon-btn')) {
                closeColumnFilter();
            }
        });

        const rolePasswords = { "Equipo de Contratación": "EquipoContrat", "Subsecretaría de Formación y Participación Ciudadana": "Formacion", "Subsecretaría de Organización Social": "OrgSocial", "Subsecretaría de Planeación Local y PP": "LocalPP26", "Unidad Administrativa": "UnidadAdmin" };
        let currentRole = "Invitado", pendingRole = "";
        
        document.querySelectorAll('.role-selector').forEach(sel => {
            sel.addEventListener('change', (e) => {
                if(e.target.value === "Invitado"){ 
                    currentRole="Invitado"; 
                    document.querySelectorAll('.role-selector').forEach(s => s.value = currentRole);
                    renderTable(); renderAnexoTable(); 
                    return; 
                }
                pendingRole = e.target.value; 
                document.getElementById('modalRoleName').innerText = pendingRole;
                document.getElementById('passwordInput').value = ""; 
                document.getElementById('passwordModal').style.display = "flex";
            });
        });

        function verifyPassword(){
            if(document.getElementById('passwordInput').value === rolePasswords[pendingRole]){
                currentRole = pendingRole; 
                document.getElementById('passwordModal').style.display="none"; 
                document.querySelectorAll('.role-selector').forEach(s => s.value = currentRole);
                renderTable(); renderAnexoTable();
            } else { document.getElementById('errorMsg').style.display="block"; }
        }

        function cancelRoleChange(){ 
            document.getElementById('passwordModal').style.display="none"; 
            document.querySelectorAll('.role-selector').forEach(s => s.value = currentRole);
        }

        function checkPermissions(owner, role) {
            if(role === 'Equipo de Contratación') return true; 
            if(role === 'Invitado') return false;
            if(!owner) return true; 
            return String(owner).trim().toUpperCase() === String(role).trim().toUpperCase();
        }

        const getColCss = (c) => {
            let col = String(c).toUpperCase();
            if(['MODALIDAD'].includes(col)) return 'width: 220px; min-width: 220px; max-width: 220px; white-space: normal; line-height: 1.3; overflow-wrap: break-word;';
            if(['CAUSAL', 'DURACIÓN DEL PROYECTO'].includes(col)) return 'width: 90px; min-width: 90px; max-width: 90px; white-space: normal; line-height: 1.3; overflow-wrap: break-word;';
            if(col.includes('INDICADOR PLAN DE DLLO')) return 'width: 140px; min-width: 140px; max-width: 140px; white-space: normal; line-height: 1.3; overflow-wrap: break-word;';
            if(['ESTADO'].includes(col)) return 'width: 160px; min-width: 160px; max-width: 160px;';
            if(col.includes('CLASIFICADOR CPC') || ['TRASLADAR A PROYECTO', 'TRASLADAR A POSPRE'].includes(col)) return 'width: 160px; min-width: 160px; max-width: 160px; white-space: normal; line-height: 1.3; overflow-wrap: break-word;';
            if(['ACTIVIDAD MGA'].includes(col)) return 'width: 140px; min-width: 140px; max-width: 140px; white-space: normal; line-height: 1.3; overflow-wrap: break-word;';
            if(['OBJETO', 'OBSERVACIÓN', 'ACTIVIDAD DETALLADA', 'ACTIVIDADES DETALLADAS'].includes(col)) return 'width: 350px; min-width: 350px; max-width: 350px; white-space: normal; line-height: 1.3; overflow-wrap: break-word;';
            return 'min-width: 120px;';
        };

        function renderTable() {
            document.getElementById('btnCrearNecesidad').style.display = (currentRole === 'Equipo de Contratación') ? 'flex' : 'none';
            const tbody = document.getElementById('tableBody');
            
            let h = '<tr>'; 
            dynamicPlanHeaders.forEach(c => {
                let css = getColCss(c);
                let sAttr = css ? `style="${css}"` : '';
                
                let filterBtn = '';
                if (!noFilterCols.includes(c)) {
                    let isFiltered = activeColFiltersPlan[c] ? 'active' : '';
                    filterBtn = `<button class="filter-icon-btn ${isFiltered}" onclick="openColumnFilter(event, '${c}', 'Plan')">🔽</button>`;
                }
                
                let dragAttrs = currentRole === 'Equipo de Contratación' ? 
                    `draggable="true" class="draggable" ondragstart="handleDragStart(event, '${c}', 'Plan')" ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event, '${c}', 'Plan')" ondragend="handleDragEnd(event)"` : '';

                h += `<th ${sAttr} ${dragAttrs}>
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div class="sort-container" onclick="toggleSort('${c}')">${c} <span class="sort-icon ${sortCol === c ? 'active' : ''}">↕</span></div>
                            ${filterBtn}
                        </div>
                      </th>`;
            });
            h += '<th class="sticky-action-th" style="width: 95px; text-align: center;">⚙️</th></tr>';
            document.getElementById('tableHead').innerHTML = h; tbody.innerHTML = '';
            
            let vis = 0, tot = 0; 
            let fP = document.getElementById('filterProyecto').value, 
                fPosprePlan = document.getElementById('filterPosprePlan')?.value || "";
            
            let sObjeto = document.getElementById('searchObjeto')?.value.toLowerCase() || "";
                
            appData.forEach((r, i) => {
                if(fP && String(r.Proyecto) !== String(fP)) return; 
                if(fPosprePlan && String(r["Posición Presupuestaría"]) !== String(fPosprePlan)) return;
                
                if (sObjeto) {
                    let obj = String(r["Objeto"] || "").toLowerCase();
                    if (!obj.includes(sObjeto)) return;
                }

                let passesColFilters = true;
                for (let col in activeColFiltersPlan) {
                    if (activeColFiltersPlan[col] && activeColFiltersPlan[col].length > 0) {
                        if (!activeColFiltersPlan[col].includes(String(r[col] || "").trim())) {
                            passesColFilters = false; break;
                        }
                    }
                }
                if (!passesColFilters) return;
                
                vis++; 
                tot += Number(r["Valor Unitario"]) || 0;
                
                let canRow = checkPermissions(r["Subsecretaría"], currentRole);
                let tr = document.createElement('tr'); tr.className = canRow ? 'row-editable' : 'row-locked';
                tr.setAttribute('data-rowid', r.ID);
                
                dynamicPlanHeaders.forEach(cn => {
                    let v = r[cn] ?? ''; let td = document.createElement('td');
                    let css = getColCss(cn);
                    if (css) td.style.cssText = css;

                    const columnasEstaticas = ["ACTIVIDAD MGA", "Codigo producto MGA", "Codigo CPC", "Subsecretaría"];

                    // Edición ahora ocurre vía modal (botón ✏️), las celdas son de solo lectura
                    let canEditCell = false;

                    if(canEditCell){
                        if (cn === "Actividad detallada") {
                            let currentProject = r.Proyecto;
                            let anexoActivities = new Set();
                            if (currentProject) {
                                anexoData.forEach(anexoRow => {
                                    if (String(anexoRow.Proyecto) === String(currentProject) && anexoRow["ACTIVIDADES DETALLADAS"]) {
                                        anexoActivities.add(anexoRow["ACTIVIDADES DETALLADAS"]);
                                    }
                                });
                            }
                            let optionsHTML = `<option value=""></option>`;
                            let found = false;
                            Array.from(anexoActivities).sort().forEach(o => {
                                let isSelected = String(v).trim() === String(o).trim();
                                if(isSelected) found = true;
                                optionsHTML += `<option value="${o}" ${isSelected ? 'selected' : ''}>${o}</option>`;
                            });
                            if(v !== "" && !found) optionsHTML += `<option value="${v}" selected>${v}</option>`;
                            td.innerHTML = `<div class="cell-display" onclick="this.style.display='none'; this.nextElementSibling.style.display='block'; this.nextElementSibling.focus();">${v || '&nbsp;'}</div><select class="cell-input plan-input" style="display:none;" data-id="${r.ID}" data-col="${cn}" onblur="setTimeout(() => { this.style.display='none'; if(this.previousElementSibling) this.previousElementSibling.style.display='block'; }, 150);">${optionsHTML}</select>`;
                        } else if (columnasMixtas.includes(cn)) {
                            let dlId = 'list-' + cn.replace(/\s+/g, '');
                            td.innerHTML = `<div class="cell-display" onclick="this.style.display='none'; this.nextElementSibling.style.display='block'; this.nextElementSibling.focus();">${v || '&nbsp;'}</div><input type="text" class="cell-input plan-input" style="display:none;" data-id="${r.ID}" data-col="${cn}" list="${dlId}" value="${v}" onblur="this.style.display='none'; this.previousElementSibling.style.display='block';">`;
                        } else if((listasDesplegables[cn] && listasDesplegables[cn].length > 0) || dependenciasColumna[cn]){
                            let opts = (listasDesplegables[cn] && listasDesplegables[cn].length > 0) ? listasDesplegables[cn] : (mapasDependientes[dependenciasColumna[cn]]?.[r.Proyecto] || []);
                            let found = false;
                            let optionsHTML = `<option value=""></option>`;
                            opts.forEach(o => {
                                let isSelected = String(v).trim() === String(o).trim();
                                if(isSelected) found = true;
                                optionsHTML += `<option value="${o}" ${isSelected ? 'selected' : ''}>${o}</option>`;
                            });
                            if(v !== "" && !found) optionsHTML += `<option value="${v}" selected>${v}</option>`;
                            td.innerHTML = `<div class="cell-display" onclick="this.style.display='none'; this.nextElementSibling.style.display='block'; this.nextElementSibling.focus();">${v || '&nbsp;'}</div><select class="cell-input plan-input" style="display:none;" data-id="${r.ID}" data-col="${cn}" onblur="setTimeout(() => { this.style.display='none'; if(this.previousElementSibling) this.previousElementSibling.style.display='block'; }, 150);">${optionsHTML}</select>`;
                        } else if(columnasMoneda.includes(cn)) {
                            td.innerHTML = `<div class="cell-display" onclick="this.style.display='none'; this.nextElementSibling.style.display='block'; this.nextElementSibling.focus();">${v ? formatMoneda(v) : '&nbsp;'}</div><input type="text" class="cell-input curr plan-input" style="display:none;" data-id="${r.ID}" data-col="${cn}" value="${v?formatMoneda(v):''}" onblur="this.style.display='none'; this.previousElementSibling.style.display='block';">`;
                        } else if(columnasFecha.includes(cn)) {
                            let dateVal = v ? toYYYYMMDD(v) : '';
                            let validDate = /^\d{4}-\d{2}-\d{2}$/.test(dateVal);
                            let displayVal = validDate ? toDDMMAAAA(v) : (v || '&nbsp;');
                            td.innerHTML = `<div class="cell-display" onclick="this.style.display='none'; this.nextElementSibling.style.display='block'; this.nextElementSibling.focus();">${displayVal}</div><input type="date" class="cell-input plan-input" style="display:none;" data-id="${r.ID}" data-col="${cn}" value="${validDate ? dateVal : ''}" onblur="this.style.display='none'; this.previousElementSibling.style.display='block';">`;
                        } else {
                            td.innerText = v;
                            td.contentEditable = true;
                            td.className = "plan-input";
                            td.dataset.id = r.ID;
                            td.dataset.col = cn;
                        }
                    } else {
                        let dVal = v;
                        if(columnasMoneda.includes(cn) && v !== "") dVal = formatMoneda(v);
                        else if(columnasFecha.includes(cn) && v !== "") dVal = toDDMMAAAA(v);
                        td.innerText = dVal;
                    }
                    tr.appendChild(td);
                });
                
                let actionTd = document.createElement('td');
                actionTd.className = 'sticky-action-td';
                actionTd.style.whiteSpace = 'nowrap';
                if (canRow && currentRole !== 'Invitado') {
                    actionTd.innerHTML = `<button class="btn-edit-row" onclick="abrirEditorFila('plan', '${r.ID}')" title="Editar fila">✏️</button>`;
                }
                if(currentRole === 'Equipo de Contratación') {
                    actionTd.innerHTML += `<button class="btn-copy" onclick="copiarFilaPlan('${r.ID}')" title="Duplicar Fila">📋</button><button class="btn-delete" onclick="eliminarFila('Plan', '${r.ID}')" title="Eliminar Fila">❌</button>`;
                }
                tr.appendChild(actionTd); tbody.appendChild(tr);
            });
            document.getElementById('summaryBar').innerText = `Mostrando ${vis} de ${appData.length} | Total: ${formatMoneda(tot)}`;
            attachListeners('plan-input', appData, renderTable);
        }

        function renderAnexoTable() {
            document.getElementById('btnCrearFilaAnexo').style.display = (currentRole !== 'Invitado') ? 'flex' : 'none';
            const tbody = document.getElementById('anexoTableBody');
            
            let h = '<tr>'; 
            dynamicAnexoHeaders.forEach(c => {
                let css = getColCss(c);
                let sAttr = css ? `style="${css}"` : '';
                
                let filterBtn = '';
                if (!noFilterCols.includes(c)) {
                    let isFiltered = activeColFiltersAnexo[c] ? 'active' : '';
                    filterBtn = `<button class="filter-icon-btn ${isFiltered}" onclick="openColumnFilter(event, '${c}', 'Anexo')">🔽</button>`;
                }
                
                let dragAttrs = currentRole === 'Equipo de Contratación' ? 
                    `draggable="true" class="draggable" ondragstart="handleDragStart(event, '${c}', 'Anexo')" ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event, '${c}', 'Anexo')" ondragend="handleDragEnd(event)"` : '';

                h += `<th ${sAttr} ${dragAttrs}>
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div class="sort-container" onclick="toggleSort('${c}', true)">${c} <span class="sort-icon ${sortCol === c ? 'active' : ''}">↕</span></div>
                            ${filterBtn}
                        </div>
                      </th>`;
            });
            h += '<th class="sticky-action-th" style="width: 80px; text-align: center;">⚙️</th></tr>'; 
            document.getElementById('anexoTableHead').innerHTML = h; tbody.innerHTML = '';
            
            let totAnex = 0, fP = document.getElementById('filterProyectoAnexo').value;
            let fA = document.getElementById('filterActividadMGA')?.value || "";
            let fPospre = document.getElementById('filterPospreAnexo')?.value || "";
            
            anexoData.forEach((r, i) => {
                if(String(r.Proyecto) !== String(fP)) return; 
                if(fA && String(r["ACTIVIDAD MGA"]) !== String(fA)) return;
                if(fPospre && String(r["Clasificador por objeto de gasto (POSPRE)"]) !== String(fPospre)) return;
                
                let passesColFilters = true;
                for (let col in activeColFiltersAnexo) {
                    if (activeColFiltersAnexo[col] && activeColFiltersAnexo[col].length > 0) {
                        if (!activeColFiltersAnexo[col].includes(String(r[col] || "").trim())) {
                            passesColFilters = false; break;
                        }
                    }
                }
                if (!passesColFilters) return;

                totAnex += Number(r["COSTO TOTAL"]) || 0;
                
                let can = checkPermissions(r["Subsecretaría"], currentRole);
                let tr = document.createElement('tr'); tr.className = can ? 'row-editable' : 'row-locked';
                tr.setAttribute('data-rowid', r.ID);
                
                dynamicAnexoHeaders.forEach(cn => {
                    let v = r[cn] ?? ''; let td = document.createElement('td');
                    let css = getColCss(cn);
                    if (css) td.style.cssText = css;

                    if(false && can && cn !== "COSTO UNITARIO" && cn !== "Subsecretaría"){
                        if(columnasMixtas.includes(cn)){
                            let dlId = 'list-' + cn.replace(/\s+/g, '');
                            td.innerHTML = `<div class="cell-display" onclick="this.style.display='none'; this.nextElementSibling.style.display='block'; this.nextElementSibling.focus();">${v || '&nbsp;'}</div><input type="text" class="cell-input anexo-input" style="display:none;" data-id="${r.ID}" data-col="${cn}" list="${dlId}" value="${v}" onblur="this.style.display='none'; this.previousElementSibling.style.display='block';">`;
                        } else if((listasDesplegables[cn] && listasDesplegables[cn].length > 0) || cn === "Clasificador por objeto de gasto (POSPRE)"){
                            let ln = cn === "Clasificador por objeto de gasto (POSPRE)" ? "Posición Presupuestaría" : cn;
                            let opts = listasDesplegables[ln] || [];
                            let found = false;
                            let optionsHTML = `<option value=""></option>`;
                            opts.forEach(o => {
                                let isSelected = String(v).trim() === String(o).trim();
                                if(isSelected) found = true;
                                optionsHTML += `<option value="${o}" ${isSelected ? 'selected' : ''}>${o}</option>`;
                            });
                            if(v !== "" && !found) optionsHTML += `<option value="${v}" selected>${v}</option>`;
                            td.innerHTML = `<div class="cell-display" onclick="this.style.display='none'; this.nextElementSibling.style.display='block'; this.nextElementSibling.focus();">${v || '&nbsp;'}</div><select class="cell-input anexo-input" style="display:none;" data-id="${r.ID}" data-col="${cn}" onblur="setTimeout(() => { this.style.display='none'; if(this.previousElementSibling) this.previousElementSibling.style.display='block'; }, 150);">${optionsHTML}</select>`;
                        } else if(columnasMoneda.includes(cn)) {
                            td.innerHTML = `<div class="cell-display" onclick="this.style.display='none'; this.nextElementSibling.style.display='block'; this.nextElementSibling.focus();">${v ? formatMoneda(v) : '&nbsp;'}</div><input type="text" class="cell-input curr anexo-input" style="display:none;" data-id="${r.ID}" data-col="${cn}" value="${v?formatMoneda(v):''}" onblur="this.style.display='none'; this.previousElementSibling.style.display='block';">`;
                        } else if(columnasFecha.includes(cn)) {
                            let dateVal = v ? toYYYYMMDD(v) : '';
                            let validDate = /^\d{4}-\d{2}-\d{2}$/.test(dateVal);
                            let displayVal = validDate ? toDDMMAAAA(v) : (v || '&nbsp;');
                            td.innerHTML = `<div class="cell-display" onclick="this.style.display='none'; this.nextElementSibling.style.display='block'; this.nextElementSibling.focus();">${displayVal}</div><input type="date" class="cell-input anexo-input" style="display:none;" data-id="${r.ID}" data-col="${cn}" value="${validDate ? dateVal : ''}" onblur="this.style.display='none'; this.previousElementSibling.style.display='block';">`;
                        } else {
                            td.innerText = v;
                            td.contentEditable = true; 
                            td.className = "anexo-input"; 
                            td.dataset.id = r.ID; 
                            td.dataset.col = cn;
                        }
                    } else {
                        td.innerText = columnasMoneda.includes(cn) && v !== "" ? formatMoneda(v) : v;
                    }
                    tr.appendChild(td);
                });
                
                let delTd = document.createElement('td');
                delTd.className = 'sticky-action-td';
                delTd.style.whiteSpace = 'nowrap';
                if (can && currentRole !== 'Invitado') {
                    delTd.innerHTML = `<button class="btn-edit-row" onclick="abrirEditorFila('anexo', '${r.ID}')" title="Editar fila">✏️</button>`;
                }
                if (can) {
                    delTd.innerHTML += `<button class="btn-delete" onclick="eliminarFila('Anexo', '${r.ID}')">❌</button>`;
                }
                tr.appendChild(delTd); tbody.appendChild(tr);
            });
            
            let totPlan = 0;
            appData.forEach(r => { 
                if(String(r.Proyecto) === String(fP)) {
                    totPlan += Number(r["Valor Unitario"]) || 0;
                }
            });
            let diff = Math.abs(totPlan - totAnex);
            
            let diffHtml = diff > 1 
                ? ` | <span style="color: #dc2626; font-weight: 700;">⚠️ Diferencia con Plan: ${formatMoneda(diff)}</span>`
                : ` | <span style="color: #059669; font-weight: 600;">✅ Cuadra con Plan</span>`;
            
            document.getElementById('summaryBarAnexo').innerHTML = `Total Proyecto: ${formatMoneda(totAnex)}${fP ? diffHtml : ''}`;
            attachListeners('anexo-input', anexoData, renderAnexoTable);
        }

        let toastTimeout;
        function mostrarNotificacion(msg) {
            let toast = document.getElementById('toast');
            if(toast) {
                toast.innerText = msg;
                toast.style.display = 'block';
                clearTimeout(toastTimeout);
                toastTimeout = setTimeout(() => toast.style.display = 'none', 3000);
            }
        }

        document.addEventListener('keydown', function(e) {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                let isInputActive = document.activeElement && 
                    (document.activeElement.tagName === 'INPUT' || 
                     document.activeElement.tagName === 'SELECT' || 
                     document.activeElement.isContentEditable);
                     
                if (isInputActive) { return; }
                e.preventDefault(); ejecutarDeshacer();
            }
        });

        function ejecutarDeshacer() {
            if (historyStack.length === 0) { mostrarNotificacion("No hay cambios guardados para deshacer."); return; }
            
            let isCurrentAnexo = currentView === 'Anexo';
            let changeIndex = -1;
            for (let i = historyStack.length - 1; i >= 0; i--) {
                if (historyStack[i].isAnexo === isCurrentAnexo) { changeIndex = i; break; }
            }

            if (changeIndex === -1) { mostrarNotificacion("No hay cambios en esta vista para deshacer."); return; }

            let lastChange = historyStack.splice(changeIndex, 1)[0];
            let dataArr = lastChange.isAnexo ? anexoData : appData;
            
            let rowIndex = dataArr.findIndex(r => r.ID === lastChange.id);
            if (rowIndex !== -1) {
                let id = lastChange.id; let c = lastChange.col; let restoredVal = lastChange.oldVal;
                dataArr[rowIndex][c] = restoredVal;
                
                let del = lastChange.isAnexo ? anexoDeltas : planDeltas;
                if(!del.adds.find(r=>r.ID===id)){
                    let u = del.updates.find(x=>x.id===id && x.field===c);
                    if(u) u.value = restoredVal; else del.updates.push({id, field:c, value:restoredVal});
                }
                
                if(lastChange.isAnexo && (c === "CANTIDAD" || c === "COSTO TOTAL")){
                    let q = Number(dataArr[rowIndex]["CANTIDAD"])||0, t = Number(dataArr[rowIndex]["COSTO TOTAL"])||0;
                    let nuevoUnitario = q > 0 ? t / q : 0;
                    dataArr[rowIndex]["COSTO UNITARIO"] = nuevoUnitario;
                    
                    if(!del.adds.find(r=>r.ID===id)){
                        let uUnitario = del.updates.find(x=>x.id===id && x.field==="COSTO UNITARIO");
                        if(uUnitario) uUnitario.value = nuevoUnitario; else del.updates.push({id, field:"COSTO UNITARIO", value:nuevoUnitario});
                    }
                }
                mostrarNotificacion("✅ Deshecho: Se restauró la columna '" + c + "'");
                lastChange.isAnexo ? renderAnexoTable() : renderTable(); triggerAutoSave();
            }
        }

        let lastSavedEdit = { key: null, time: 0 };

        function attachListeners(cls, data, func) {
            document.querySelectorAll('.'+cls).forEach(el => {
                if (el.dataset.listenerBound === '1') return;
                el.dataset.listenerBound = '1';
                let evtType = (el.tagName === 'SELECT' || el.type === 'date') ? 'change' : 'blur';

                el.addEventListener(evtType, (e) => {
                    let rowId = e.target.dataset.id, c = e.target.dataset.col;
                    let i = data.findIndex(r => r.ID === rowId);
                    if (i === -1) return;

                    let v = e.target.value !== undefined ? e.target.value : e.target.innerText.trim();
                    let originalV = v; let isNumeric = false;
                    
                    if(e.target.classList.contains('curr')){ 
                        isNumeric = true; v = v.replace(/\D/g, ''); if(!v) v=0; 
                    } else if (columnasNumericas.includes(c)) {
                        isNumeric = true; v = String(v).replace(/\D/g, ''); v = v !== '' ? Number(v) : 0;
                    }
                    
                    let hasLetters = /[a-zA-Z]/.test(originalV);
                    if (isNumeric && hasLetters) {
                        document.getElementById('msgModalTitle').innerText = '⚠️ Dato Numérico Requerido';
                        document.getElementById('msgModalTitle').style.color = 'var(--text-main)';
                        document.getElementById('msgModalBody').innerText = `La columna "${c}" solo acepta números.\n\nLas letras que escribiste ("${originalV}") han sido eliminadas automáticamente.`;
                        document.getElementById('msgModal').style.display = 'flex';
                    }
                    
                    if(isNumeric && !isNaN(v) && v !== "") v = Number(v);

                    let oldVal = data[i][c]; if (oldVal === undefined) oldVal = "";

                    let editKey = rowId + '||' + c;
                    let now = Date.now();
                    if (editKey === lastSavedEdit.key &&
                        (now - lastSavedEdit.time) < 500 &&
                        (v === '' || v === 0) &&
                        oldVal !== '' && oldVal !== 0) {
                        return;
                    }

                    if(oldVal !== v){
                        historyStack.push({ isAnexo: data === anexoData, id: data[i].ID, index: i, col: c, oldVal: oldVal, newVal: v });
                        if (historyStack.length > 30) historyStack.shift();

                        data[i][c] = v; let id = data[i].ID; let del = data === appData ? planDeltas : anexoDeltas;

                        lastSavedEdit = { key: editKey, time: now };

                        let activeFilters = data === appData ? activeColFiltersPlan : activeColFiltersAnexo;
                        if (activeFilters[c] && activeFilters[c].length > 0) {
                            let filterVal = String(v ?? "").trim();
                            if (!activeFilters[c].includes(filterVal)) {
                                activeFilters[c].push(filterVal);
                            }
                        }
                        
                        if (data === appData && c === "Actividad detallada") {
                            let currentProject = data[i].Proyecto;
                            let matchedRow = anexoData.find(row => String(row.Proyecto) === String(currentProject) && String(row["ACTIVIDADES DETALLADAS"]).trim() === String(v).trim());
                            if (matchedRow) {
                                data[i]["ACTIVIDAD MGA"] = matchedRow["ACTIVIDAD MGA"] || "";
                                data[i]["Codigo producto MGA"] = matchedRow["CÓDIGO PRODUCTO MGA"] || "";
                                data[i]["Codigo CPC"] = matchedRow["Clasificador CPC"] || "";
                            } else if (v === "") {
                                data[i]["ACTIVIDAD MGA"] = ""; data[i]["Codigo producto MGA"] = ""; data[i]["Codigo CPC"] = "";
                            }
                        }

                        if (c === "Proyecto" && mapaProySubse[v]) {
                            let nuevaSub = mapaProySubse[v];
                            if (data[i]["Subsecretaría"] !== nuevaSub) {
                                data[i]["Subsecretaría"] = nuevaSub;
                                if(!del.adds.find(r=>r.ID===id)){
                                    let uSub = del.updates.find(x=>x.id===id && x.field==="Subsecretaría");
                                    if(uSub) uSub.value = nuevaSub; else del.updates.push({id, field:"Subsecretaría", value:nuevaSub});
                                }
                            }
                        }
                        
                        if(!del.adds.find(r=>r.ID===id)){
                            let u = del.updates.find(x=>x.id===id && x.field===c);
                            if(u) u.value = v; else del.updates.push({id, field:c, value:v});
                        }
                        if(data === anexoData && (c === "CANTIDAD" || c === "COSTO TOTAL")){
                            let q = Number(data[i]["CANTIDAD"])||0, t = Number(data[i]["COSTO TOTAL"])||0;
                            let nuevoUnitario = q > 0 ? t / q : 0;
                            data[i]["COSTO UNITARIO"] = nuevoUnitario;
                            
                            if(!del.adds.find(r=>r.ID===id)){
                                let uUnitario = del.updates.find(x=>x.id===id && x.field==="COSTO UNITARIO");
                                if(uUnitario) uUnitario.value = nuevoUnitario; else del.updates.push({id, field:"COSTO UNITARIO", value:nuevoUnitario});
                            }
                        }
                        setTimeout(() => { func(); triggerAutoSave(); }, 0);
                    } else if (isNumeric && hasLetters) { 
                        setTimeout(() => { func(); }, 0);
                    }
                });
            });
        }

        // ============== EDITOR DE FILA (MODAL) ==============
        let editingRowId = null;
        let editingDataType = null; // 'plan' o 'anexo'

        function escapeHtml(s) {
            return String(s ?? '').replace(/[&<>"']/g, function(c) {
                return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
            });
        }

        function buildEditField(col, val, row, type) {
            const colEsc = escapeHtml(col);
            const valStr = val === undefined || val === null ? '' : String(val);
            const valEsc = escapeHtml(valStr);

            // Bloqueo 1: columnas-fórmula del sheets o calculadas (siempre solo lectura)
            const isFormulaCol = (type === 'plan' && formulaColsPlan.includes(col)) ||
                                 (type === 'anexo' && formulaColsAnexo.includes(col)) ||
                                 (calculadasReadonly[type] || []).includes(col);
            // Bloqueo 2: permisos por rol
            //   Plan no-admin: solo puede tocar "Actividad detallada"
            //   Anexo no-admin: no puede tocar Proyecto ni Subsecretaría
            const isAdmin = currentRole === 'Equipo de Contratación';
            const isLockedByRole = !isAdmin && (
                (type === 'plan'  && !planEditableNonAdmin.includes(col)) ||
                (type === 'anexo' && adminOnlyAnexo.includes(col))
            );
            const isStatic = isFormulaCol || isLockedByRole || col === 'ID';
            // readonly funciona para <input>/<textarea>; <select> necesita disabled
            const lockInput = isStatic ? 'readonly' : '';
            const lockSelect = isStatic ? 'disabled' : '';

            if (columnasMoneda.includes(col)) {
                const userFormulaList = (colsFormulaUsuario[type] || []);
                if (userFormulaList.includes(col)) {
                    // Acepta moneda o fórmula tipo =200+200; si el sheets tiene fórmula
                    // guardada (campo `${col}_formula`), la mostramos cruda para que la
                    // pueda seguir editando.
                    const formulaStored = row[col + '_formula'];
                    let show;
                    if (typeof formulaStored === 'string' && formulaStored.charAt(0) === '=') {
                        show = formulaStored;
                    } else {
                        show = val !== '' && val !== null && val !== undefined ? formatMoneda(val) : '';
                    }
                    return `<input type="text" data-col="${colEsc}" data-userformula="1" value="${escapeHtml(show)}" placeholder="$ o =200+200" ${lockInput}>`;
                }
                const display = val !== '' && val !== null && val !== undefined ? formatMoneda(val) : '';
                return `<input type="text" data-col="${colEsc}" data-currency="1" value="${escapeHtml(display)}" ${lockInput}>`;
            }
            if (columnasFecha.includes(col)) {
                let dateVal = val ? toYYYYMMDD(val) : '';
                let valid = /^\d{4}-\d{2}-\d{2}$/.test(dateVal);
                if (valid) {
                    return `<input type="date" data-col="${colEsc}" value="${escapeHtml(dateVal)}" ${lockInput}>`;
                }
                return `<input type="text" data-col="${colEsc}" value="${valEsc}" placeholder="yyyy-mm-dd o texto" ${lockInput}>`;
            }
            if (columnasNumericas.includes(col)) {
                return `<input type="number" data-col="${colEsc}" value="${valEsc}" step="any" ${lockInput}>`;
            }
            // Dependencias dinámicas: "Actividad detallada" depende de Proyecto (anexoData)
            if (type === 'plan' && col === 'Actividad detallada') {
                const proyecto = row['Proyecto'];
                const activities = new Set();
                if (proyecto) {
                    anexoData.forEach(ar => {
                        if (String(ar.Proyecto) === String(proyecto) && ar["ACTIVIDADES DETALLADAS"]) {
                            activities.add(ar["ACTIVIDADES DETALLADAS"]);
                        }
                    });
                }
                let opts = '<option value=""></option>';
                let found = false;
                Array.from(activities).sort().forEach(o => {
                    const sel = String(valStr).trim() === String(o).trim();
                    if (sel) found = true;
                    opts += `<option value="${escapeHtml(o)}" ${sel ? 'selected' : ''}>${escapeHtml(o)}</option>`;
                });
                if (valStr !== '' && !found) opts += `<option value="${valEsc}" selected>${valEsc}</option>`;
                return `<select data-col="${colEsc}" ${lockSelect}>${opts}</select>`;
            }
            // Listas desplegables o dependencias
            const hasList = listasDesplegables[col] && listasDesplegables[col].length > 0;
            const dependencyKey = dependenciasColumna[col];
            if (hasList || (dependencyKey && mapasDependientes[dependencyKey]?.[row.Proyecto])) {
                const list = hasList
                    ? listasDesplegables[col]
                    : (mapasDependientes[dependencyKey]?.[row.Proyecto] || []);
                let opts = '<option value=""></option>';
                let found = false;
                list.forEach(o => {
                    const sel = String(valStr).trim() === String(o).trim();
                    if (sel) found = true;
                    opts += `<option value="${escapeHtml(o)}" ${sel ? 'selected' : ''}>${escapeHtml(o)}</option>`;
                });
                if (valStr !== '' && !found) opts += `<option value="${valEsc}" selected>${valEsc}</option>`;
                return `<select data-col="${colEsc}" ${lockSelect}>${opts}</select>`;
            }
            // Mixtas: input con datalist
            if (columnasMixtas.includes(col)) {
                const dlId = 'list-' + col.replace(/\s+/g, '');
                return `<input type="text" list="${dlId}" data-col="${colEsc}" value="${valEsc}" ${lockInput}>`;
            }
            // Texto largo (multilínea)
            const longTextCols = ['Objeto', 'Observación', 'Necesidad', 'Estudio Previo', 'Actividad detallada', 'ACTIVIDADES DETALLADAS'];
            if (longTextCols.includes(col)) {
                return `<textarea data-col="${colEsc}" ${lockInput}>${valEsc}</textarea>`;
            }
            // Texto plano
            return `<input type="text" data-col="${colEsc}" value="${valEsc}" ${lockInput}>`;
        }

        function abrirEditorFila(type, id) {
            const data = type === 'plan' ? appData : anexoData;
            const headers = type === 'plan' ? predefinedHeaders : anexoHeaders;
            const row = data.find(r => r.ID === id);
            if (!row) { mostrarNotificacion('⚠️ Fila no encontrada'); return; }

            editingRowId = id;
            editingDataType = type;

            const container = document.getElementById('editRowFields');
            container.innerHTML = '';

            headers.forEach(col => {
                const val = row[col] ?? '';
                const fieldHTML = buildEditField(col, val, row, type);
                const fullWidth = ['Objeto', 'Observación', 'Necesidad', 'Estudio Previo', 'ACTIVIDADES DETALLADAS'].includes(col);
                const group = document.createElement('div');
                group.className = 'field-group' + (fullWidth ? ' full-width' : '');
                group.innerHTML = `<label>${escapeHtml(col)}</label>${fieldHTML}`;
                container.appendChild(group);
            });

            // Si cambia el Proyecto en el modal de Plan, re-renderiza el dropdown
            // de "Actividad detallada" para que coincida con las del Anexo del nuevo proyecto.
            if (type === 'plan') {
                const selProy = container.querySelector('[data-col="Proyecto"]');
                if (selProy) {
                    selProy.addEventListener('change', () => {
                        const actField = container.querySelector('[data-col="Actividad detallada"]');
                        if (!actField) return;
                        const grupo = actField.closest('.field-group');
                        if (!grupo) return;
                        const fakeRow = Object.assign({}, row, { Proyecto: selProy.value });
                        const newHTML = buildEditField('Actividad detallada', '', fakeRow, 'plan');
                        grupo.innerHTML = `<label>${escapeHtml('Actividad detallada')}</label>${newHTML}`;
                    });
                }
            }

            document.getElementById('editRowModalTitle').innerText = 'Editar fila (' + (type === 'plan' ? 'Plan de Compras' : 'Anexo Presupuestal') + ')';
            const statusEl = document.getElementById('editRowStatus');
            statusEl.innerText = '';
            statusEl.style.fontWeight = '';
            statusEl.style.color = 'var(--text-muted)';
            const saveBtn = document.getElementById('editRowSaveBtn');
            saveBtn.disabled = false;
            saveBtn.style.background = '';
            saveBtn.style.borderColor = '';
            saveBtn.innerText = '💾 Guardar';
            document.getElementById('editRowModal').style.display = 'flex';
        }

        function closeEditRowModal() {
            document.getElementById('editRowModal').style.display = 'none';
            editingRowId = null;
            editingDataType = null;
        }

        async function guardarFilaModal(e) {
            e.preventDefault();
            if (!editingRowId || !editingDataType) return;

            const saveBtn = document.getElementById('editRowSaveBtn');
            const statusEl = document.getElementById('editRowStatus');
            saveBtn.disabled = true;
            saveBtn.style.background = 'var(--danger)';
            saveBtn.style.borderColor = 'var(--danger)';
            // Mantén el texto del botón intacto; el aviso va solo en el statusEl
            statusEl.style.color = 'var(--danger)';
            statusEl.style.fontWeight = '700';
            statusEl.innerText = '⏳ Guardando, espera por favor...';

            // Construir record. Las columnas con fórmula del usuario (Valor Unitario,
            // COSTO TOTAL) pueden venir como =200+200; se validan, y guardamos por
            // separado la fórmula cruda para que (a) el backend la escriba como
            // setFormula y (b) la podamos mostrar de nuevo en el modal al re-editar.
            const record = { ID: editingRowId };
            const formulasUsuario = {}; // col -> '=200+200' (solo si aplica)
            let errorFormula = null;
            const userFormulaList = (colsFormulaUsuario[editingDataType] || []);
            document.querySelectorAll('#editRowFields [data-col]').forEach(el => {
                if (errorFormula) return;
                const col = el.dataset.col;
                let val = el.value;
                if (el.dataset.userformula === '1') {
                    const raw = String(val || '').trim();
                    if (raw.length > 0 && raw.charAt(0) === '=') {
                        const p = parsearFormulaUsuario(raw);
                        if (!p.ok) { errorFormula = '"' + col + '": ' + p.error; return; }
                        record[col] = raw;                 // string con '=' para backend
                        formulasUsuario[col] = { formula: raw, value: p.value };
                    } else {
                        // moneda normal
                        const s = String(val || '').replace(/\D/g, '');
                        record[col] = s !== '' ? Number(s) : 0;
                        formulasUsuario[col] = null;
                    }
                    return;
                }
                if (el.dataset.currency === '1') {
                    val = String(val).replace(/\D/g, '');
                    val = val !== '' ? Number(val) : 0;
                } else if (columnasNumericas.includes(col)) {
                    // Acepta decimales con coma O punto.
                    const s = String(val || '').trim().replace(',', '.');
                    val = s === '' ? '' : Number(s);
                }
                record[col] = val;
            });

            if (errorFormula) {
                saveBtn.style.background = '';
                saveBtn.style.borderColor = '';
                statusEl.style.color = 'var(--danger)';
                statusEl.innerText = '❌ Fórmula inválida en ' + errorFormula;
                saveBtn.disabled = false;
                return;
            }

            // Sincronizar campos automáticos (Plan)
            if (editingDataType === 'plan') {
                if (record['Actividad detallada']) {
                    const proyecto = record['Proyecto'];
                    const match = anexoData.find(r => String(r.Proyecto) === String(proyecto) &&
                                                      String(r['ACTIVIDADES DETALLADAS']).trim() === String(record['Actividad detallada']).trim());
                    if (match) {
                        record['ACTIVIDAD MGA'] = match['ACTIVIDAD MGA'] || '';
                        record['Codigo producto MGA'] = match['CÓDIGO PRODUCTO MGA'] || '';
                        record['Codigo CPC'] = match['Clasificador CPC'] || '';
                    }
                }
                if (record['Proyecto'] && mapaProySubse[record['Proyecto']]) {
                    record['Subsecretaría'] = mapaProySubse[record['Proyecto']];
                }
            }

            // Recalcular costo unitario (Anexo) usando el VALOR CALCULADO de COSTO TOTAL
            // (no el string '=...' si vino como fórmula). Acepta cantidad con coma o punto.
            if (editingDataType === 'anexo') {
                let q = 0;
                const qRaw = record['CANTIDAD'];
                if (typeof qRaw === 'string') q = Number(qRaw.replace(',', '.')) || 0;
                else q = Number(qRaw) || 0;

                let t = 0;
                if (formulasUsuario['COSTO TOTAL']) {
                    t = formulasUsuario['COSTO TOTAL'].value;
                } else {
                    t = Number(record['COSTO TOTAL']) || 0;
                }
                record['COSTO UNITARIO'] = q > 0 ? t / q : 0;
            }

            // Firebase es la fuente de verdad: guardamos el record COMPLETO (con las
            // columnas derivadas ya calculadas en la app). Para las columnas con fórmula
            // del usuario guardamos el VALOR calculado (no el string "=..."), y dejamos
            // la fórmula cruda en `${col}_formula`. El Google Sheet se actualiza como espejo.
            const recordFs = Object.assign({}, record);
            Object.keys(formulasUsuario).forEach(col => {
                if (formulasUsuario[col]) {
                    recordFs[col] = formulasUsuario[col].value;
                    recordFs[col + '_formula'] = formulasUsuario[col].formula;
                } else {
                    recordFs[col + '_formula'] = null;
                }
            });

            try {
                let result = await enviarAccionConReintentos({
                    action: 'save',
                    type: editingDataType,
                    record: recordFs,
                    requestId: generateUUID()
                });

                if (result && result.status === 'success') {
                    // Aplicar cambios locales (optimista). Para las columnas con
                    // fórmula del usuario, en local guardamos el VALOR CALCULADO y
                    // dejamos la fórmula cruda en `${col}_formula`.
                    const data = editingDataType === 'plan' ? appData : anexoData;
                    const idx = data.findIndex(r => r.ID === editingRowId);
                    const finalId = result.id || record.ID;
                    if (idx !== -1) {
                        const recordLocal = Object.assign({}, record);
                        Object.keys(formulasUsuario).forEach(col => {
                            if (formulasUsuario[col]) {
                                recordLocal[col] = formulasUsuario[col].value;
                                recordLocal[col + '_formula'] = formulasUsuario[col].formula;
                            } else {
                                recordLocal[col + '_formula'] = null;
                            }
                        });
                        Object.assign(data[idx], recordLocal, { ID: finalId });
                    }
                    saveBtn.style.background = '';
                    saveBtn.style.borderColor = '';
                    statusEl.style.color = 'var(--success)';
                    statusEl.style.fontWeight = '700';
                    statusEl.innerText = '✅ Guardado';
                    const dt = editingDataType; // capturar ANTES de cerrar el modal
                    setTimeout(() => {
                        closeEditRowModal();
                        if (dt === 'plan') renderTable(); else renderAnexoTable();
                        mostrarNotificacion('✅ Cambios guardados');
                        // Re-sincronizar con el servidor 3s después para no chocar con el lock del backend
                        // NOTA: no auto-recargamos del servidor. El cambio ya quedó en local
                        // y en sheets. La recarga ocurre solo en F5 o con el botón 🔄 Recargar.
                    }, 400);
                } else {
                    saveBtn.style.background = '';
                    saveBtn.style.borderColor = '';
                    statusEl.style.color = 'var(--danger)';
                    statusEl.innerText = '❌ ' + (result.message || 'Error desconocido');
                    saveBtn.disabled = false;
                }
            } catch (err) {
                saveBtn.style.background = '';
                saveBtn.style.borderColor = '';
                statusEl.style.color = 'var(--danger)';
                let hint = '';
                const msg = (err && err.message ? err.message : String(err)).toLowerCase();
                if (msg.indexOf('fetch') !== -1 || msg.indexOf('cors') !== -1 || msg.indexOf('aborted') !== -1 || msg.indexOf('network') !== -1) {
                    hint = ' — Revisa el Apps Script: Deploy → Manage deployments → New version, con "Execute as: Me" y "Who has access: Anyone".';
                }
                statusEl.innerText = '❌ Error de conexión: ' + err.message + hint;
                saveBtn.disabled = false;
            }
        }
        // ============== FIN EDITOR DE FILA ==============

        // ============== Helper: POST con reintentos automáticos en "candado ocupado" ==============
        // Escribe en Firestore (fuente de verdad) con reintentos y actualiza el
        // Google Sheet como espejo best-effort. Mantiene el mismo contrato de
        // retorno { status, id, message } que esperaban quienes la llaman.
        async function enviarAccionConReintentos(payload, opts = {}) {
            const maxAttempts = opts.maxAttempts || 3;
            const coll = FS_COLL[payload.type];
            if (!coll) return { status: 'error', message: 'Tipo desconocido: ' + payload.type };
            let lastErr = null;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                if (attempt > 1) await new Promise(r => setTimeout(r, 1500 * (attempt - 1)));
                try {
                    if (payload.action === 'delete') {
                        await fsDelete(coll, payload.id);
                    } else {
                        await fsUpsert(coll, payload.record.ID, payload.record);
                    }
                    mirrorToSheet(payload); // espejo hacia el Sheet (no bloquea)
                    return { status: 'success', id: payload.action === 'delete' ? payload.id : payload.record.ID };
                } catch (err) {
                    lastErr = err;
                }
            }
            return { status: 'error', message: lastErr ? lastErr.message : 'error desconocido' };
        }

        function copiarFilaPlan(id) {
            let idx = appData.findIndex(r => r.ID === id);
            if (idx === -1) return;

            const original = appData[idx];
            const n = { ID: generateUUID() };
            predefinedHeaders.forEach(c => { n[c] = original[c] || ""; });

            // Inserción optimista local
            appData.splice(idx + 1, 0, n);
            renderTable();

            setTimeout(() => {
                const filaNueva = document.querySelector(`#viewPlanCompras tr[data-rowid="${n.ID}"]`);
                if (filaNueva) {
                    filaNueva.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    filaNueva.style.transition = 'background-color 0.5s';
                    filaNueva.style.backgroundColor = '#fef08a';
                }
            }, 100);

            updateSaveStatus('saving');
            enviarAccionConReintentos({ action: 'save', type: 'plan', record: n, requestId: generateUUID() })
                .then(result => {
                    if (result && result.status === 'success') {
                        if (result.id && result.id !== n.ID) n.ID = result.id;
                        updateSaveStatus('saved');
                        mostrarNotificacion('✅ Fila duplicada');
                        // No auto-recargar del servidor; los datos ya están en local.
                    } else {
                        // revertir
                        const i2 = appData.findIndex(r => r.ID === n.ID);
                        if (i2 !== -1) appData.splice(i2, 1);
                        renderTable();
                        updateSaveStatus('error');
                        mostrarNotificacion('❌ No se pudo duplicar: ' + (result && result.message || 'error desconocido'));
                    }
                })
                .catch(err => {
                    const i2 = appData.findIndex(r => r.ID === n.ID);
                    if (i2 !== -1) appData.splice(i2, 1);
                    renderTable();
                    updateSaveStatus('error');
                    mostrarNotificacion('❌ No se pudo duplicar: ' + err.message);
                });
        }

        function crearNecesidad(){
            const n = { ID: generateUUID() };
            predefinedHeaders.forEach(c => n[c] = "");

            const fP = document.getElementById('filterProyecto').value;
            const fPosprePlan = document.getElementById('filterPosprePlan')?.value || "";

            if(fPosprePlan) n["Posición Presupuestaría"] = fPosprePlan;

            let lastIndex = -1;
            if(fP) {
                n["Proyecto"] = fP;
                for(let i = 0; i < appData.length; i++){ if(String(appData[i].Proyecto) === String(fP)) lastIndex = i; }
                if (mapaProySubse[fP]) n["Subsecretaría"] = mapaProySubse[fP];
                else if(!n["Subsecretaría"] && lastIndex !== -1) n["Subsecretaría"] = appData[lastIndex]["Subsecretaría"] || "";
            }
            if(lastIndex !== -1) appData.splice(lastIndex + 1, 0, n); else appData.push(n);

            renderTable();
            setTimeout(() => {
                const filaNueva = document.querySelector(`#viewPlanCompras tr[data-rowid="${n.ID}"]`);
                if (filaNueva) {
                    filaNueva.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    filaNueva.style.transition = 'background-color 0.5s';
                    filaNueva.style.backgroundColor = '#fef08a';
                }
            }, 100);

            updateSaveStatus('saving');
            enviarAccionConReintentos({ action: 'save', type: 'plan', record: n, requestId: generateUUID() })
                .then(result => {
                    if (result && result.status === 'success') {
                        if (result.id && result.id !== n.ID) n.ID = result.id;
                        updateSaveStatus('saved');
                        mostrarNotificacion('✅ Necesidad creada');
                        // No auto-recargar del servidor; los datos ya están en local.
                    } else {
                        const i2 = appData.findIndex(r => r.ID === n.ID);
                        if (i2 !== -1) appData.splice(i2, 1);
                        renderTable();
                        updateSaveStatus('error');
                        mostrarNotificacion('❌ No se pudo crear: ' + (result && result.message || 'error desconocido'));
                    }
                })
                .catch(err => {
                    const i2 = appData.findIndex(r => r.ID === n.ID);
                    if (i2 !== -1) appData.splice(i2, 1);
                    renderTable();
                    updateSaveStatus('error');
                    mostrarNotificacion('❌ No se pudo crear: ' + err.message);
                });
        }

        function crearFilaAnexo(){
            const n = { ID: generateUUID() };
            anexoHeaders.forEach(c => n[c] = "");

            const fP = document.getElementById('filterProyectoAnexo').value;
            const fA = document.getElementById('filterActividadMGA')?.value || "";
            const fPospre = document.getElementById('filterPospreAnexo')?.value || "";

            n["Proyecto"] = fP;
            if(fA) n["ACTIVIDAD MGA"] = fA;
            if(fPospre) n["Clasificador por objeto de gasto (POSPRE)"] = fPospre;
            if (mapaProySubse[fP]) n["Subsecretaría"] = mapaProySubse[fP];

            let lastIndex = -1;
            for(let i = 0; i < anexoData.length; i++){ if(String(anexoData[i].Proyecto) === String(fP)) lastIndex = i; }
            if(!n["Subsecretaría"] && lastIndex !== -1) n["Subsecretaría"] = anexoData[lastIndex]["Subsecretaría"] || "";
            if(lastIndex !== -1) anexoData.splice(lastIndex + 1, 0, n); else anexoData.push(n);

            renderAnexoTable();
            setTimeout(() => {
                const filaNueva = document.querySelector(`#viewAnexoPresupuestal tr[data-rowid="${n.ID}"]`);
                if (filaNueva) {
                    filaNueva.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    filaNueva.style.transition = 'background-color 0.5s';
                    filaNueva.style.backgroundColor = '#fef08a';
                }
            }, 100);

            updateSaveStatus('saving');
            enviarAccionConReintentos({ action: 'save', type: 'anexo', record: n, requestId: generateUUID() })
                .then(result => {
                    if (result && result.status === 'success') {
                        if (result.id && result.id !== n.ID) n.ID = result.id;
                        updateSaveStatus('saved');
                        mostrarNotificacion('✅ Fila creada en Anexo');
                        // No auto-recargar del servidor; los datos ya están en local.
                    } else {
                        const i2 = anexoData.findIndex(r => r.ID === n.ID);
                        if (i2 !== -1) anexoData.splice(i2, 1);
                        renderAnexoTable();
                        updateSaveStatus('error');
                        mostrarNotificacion('❌ No se pudo crear: ' + (result && result.message || 'error desconocido'));
                    }
                })
                .catch(err => {
                    const i2 = anexoData.findIndex(r => r.ID === n.ID);
                    if (i2 !== -1) anexoData.splice(i2, 1);
                    renderAnexoTable();
                    updateSaveStatus('error');
                    mostrarNotificacion('❌ No se pudo crear: ' + err.message);
                });
        }

        function eliminarFila(t, id){
            if(!confirm("¿Eliminar esta fila?")) return;
            const type = t === 'Plan' ? 'plan' : 'anexo';
            const data = type === 'plan' ? appData : anexoData;
            const renderFn = type === 'plan' ? renderTable : renderAnexoTable;

            const idx = data.findIndex(r => r.ID === id);
            if (idx === -1) return;
            const backup = data[idx];

            // Eliminación optimista
            data.splice(idx, 1);
            renderFn();
            updateSaveStatus('saving');

            enviarAccionConReintentos({ action: 'delete', type: type, id: id, requestId: generateUUID() })
                .then(result => {
                    if (result && result.status === 'success') {
                        updateSaveStatus('saved');
                        mostrarNotificacion('✅ Fila eliminada');
                        // No auto-recargar del servidor; los datos ya están en local.
                    } else {
                        data.splice(idx, 0, backup); // revertir
                        renderFn();
                        updateSaveStatus('error');
                        mostrarNotificacion('❌ No se pudo eliminar: ' + (result && result.message || 'error desconocido'));
                    }
                })
                .catch(err => {
                    data.splice(idx, 0, backup);
                    renderFn();
                    updateSaveStatus('error');
                    mostrarNotificacion('❌ No se pudo eliminar: ' + err.message);
                });
        }
        
        function onProyectoPlanChange(){ 
            activeColFiltersPlan = {};
            let fP = document.getElementById('filterProyecto').value;
            let pSet = new Set();
            appData.forEach(r => {
                if(!fP || String(r.Proyecto) === String(fP)) {
                    if(r["Posición Presupuestaría"]) pSet.add(String(r["Posición Presupuestaría"]).trim());
                }
            });
            let selPospre = document.getElementById('filterPosprePlan');
            if (selPospre) {
                let currP = selPospre.value;
                selPospre.innerHTML = '<option value="">Todos los POSPRE</option>' + Array.from(pSet).sort().map(p => `<option value="${p}">${p}</option>`).join('');
                if(Array.from(pSet).includes(currP)) selPospre.value = currP; else selPospre.value = "";
            }
            renderTable(); 
        }

        function onProyectoAnexoChange(){ 
            activeColFiltersAnexo = {};
            let fP = document.getElementById('filterProyectoAnexo').value;
            let aSet = new Set();
            let pSet = new Set();
            anexoData.forEach(r => {
                if(String(r.Proyecto) === String(fP)) {
                    if(r["ACTIVIDAD MGA"]) aSet.add(String(r["ACTIVIDAD MGA"]).trim());
                    if(r["Clasificador por objeto de gasto (POSPRE)"]) pSet.add(String(r["Clasificador por objeto de gasto (POSPRE)"]).trim());
                }
            });
            let selA = document.getElementById('filterActividadMGA');
            if (selA) {
                let currA = selA.value;
                selA.innerHTML = '<option value="">Todas las Actividades</option>' + Array.from(aSet).sort().map(a => `<option value="${a}">${a}</option>`).join('');
                if(Array.from(aSet).includes(currA)) selA.value = currA; else selA.value = "";
            }
            let selPospre = document.getElementById('filterPospreAnexo');
            if (selPospre) {
                let currP = selPospre.value;
                selPospre.innerHTML = '<option value="">Todos los POSPRE</option>' + Array.from(pSet).sort().map(p => `<option value="${p}">${p}</option>`).join('');
                if(Array.from(pSet).includes(currP)) selPospre.value = currP; else selPospre.value = "";
            }
            renderAnexoTable(); 
        }
        function switchView(v){ currentView=v; document.getElementById('viewPlanCompras').classList.toggle('view-hidden', v==='Anexo'); document.getElementById('viewAnexoPresupuestal').classList.toggle('view-hidden', v==='Plan'); }

        function exportData(t){
            let d = t==='Plan' ? appData : anexoData;
            let h = t==='Plan' ? dynamicPlanHeaders : dynamicAnexoHeaders.filter(c => c !== 'Reserva');
            let fn = t==='Plan' ? "Plan_2026.xlsx" : `Anexo_${document.getElementById('filterProyectoAnexo').value || 'Completo'}.xlsx`;
            
            if(t === 'Plan') {
                let fP = document.getElementById('filterProyecto').value;
                let fPosprePlan = document.getElementById('filterPosprePlan')?.value || "";
                let sObjeto = document.getElementById('searchObjeto')?.value.toLowerCase() || "";
                
                d = d.filter(r => {
                    if(fP && String(r.Proyecto) !== String(fP)) return false; 
                    if(fPosprePlan && String(r["Posición Presupuestaría"]) !== String(fPosprePlan)) return false;
                    
                    if (sObjeto) {
                        let obj = String(r["Objeto"] || "").toLowerCase();
                        if (!obj.includes(sObjeto)) return false;
                    }

                    for (let col in activeColFiltersPlan) {
                        if (activeColFiltersPlan[col] && activeColFiltersPlan[col].length > 0) {
                            if (!activeColFiltersPlan[col].includes(String(r[col] || "").trim())) return false;
                        }
                    }
                    return true;
                });
            } else {
                let fP = document.getElementById('filterProyectoAnexo').value;
                let fA = document.getElementById('filterActividadMGA')?.value || "";
                let fPospre = document.getElementById('filterPospreAnexo')?.value || "";
                
                d = d.filter(r => {
                    if(String(r.Proyecto) !== String(fP)) return false; 
                    if(fA && String(r["ACTIVIDAD MGA"]) !== String(fA)) return false;
                    if(fPospre && String(r["Clasificador por objeto de gasto (POSPRE)"]) !== String(fPospre)) return false;
                    
                    for (let col in activeColFiltersAnexo) {
                        if (activeColFiltersAnexo[col] && activeColFiltersAnexo[col].length > 0) {
                            if (!activeColFiltersAnexo[col].includes(String(r[col] || "").trim())) return false;
                        }
                    }
                    return true;
                });
            }
            
            const ws = XLSX.utils.json_to_sheet(d.map(r => { let x={}; h.forEach(c=>x[c]=r[c]||""); return x; }));
            const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Datos"); 
            
            ws['!cols'] = h.map(c => { 
                let col = String(c).toUpperCase();
                if(['OBJETO', 'ACTIVIDAD DETALLADA', 'ACTIVIDADES DETALLADAS', 'OBSERVACIÓN', 'OBSERVACION'].includes(col)) return { wch: 60 }; 
                if(['ACTIVIDAD MGA'].includes(col)) return { wch: 15 };
                if(columnasMoneda.includes(c)) return { wch: 18 };
                return { wch: 25 }; 
            });

            const range = XLSX.utils.decode_range(ws['!ref']);
            for (let R = range.s.r; R <= range.e.r; ++R) {
                for (let C = range.s.c; C <= range.e.c; ++C) {
                    let cell_ref = XLSX.utils.encode_cell({ c: C, r: R });
                    if (!ws[cell_ref]) continue;
                    if (!ws[cell_ref].s) ws[cell_ref].s = {};
                    
                    ws[cell_ref].s.border = { top: { style: "thin", color: { rgb: "000000" } }, bottom: { style: "thin", color: { rgb: "000000" } }, left: { style: "thin", color: { rgb: "000000" } }, right: { style: "thin", color: { rgb: "000000" } } };
                    if (R === 0) {
                        ws[cell_ref].s.fill = { patternType: "solid", fgColor: { rgb: "1D4ED8" } };
                        ws[cell_ref].s.font = { bold: true, color: { rgb: "FFFFFF" } };
                        ws[cell_ref].s.alignment = { horizontal: "center", vertical: "center" };
                    } else if (columnasMoneda.includes(h[C]) && ws[cell_ref].t === 'n') {
                        ws[cell_ref].z = '"$"#,##0';
                    }
                }
            }
            XLSX.writeFile(wb, fn);
        }

        cargarDatosDesdeGoogle();
