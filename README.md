# ArchiFactura

Archivo de comprobantes en Google Drive. PWA para Android, iOS y PC.

## Funcionalidades
- Captura de facturas por foto o archivo (JPG, PNG, PDF)
- Selección de destinatario: MSA, PAM, MA
- Fecha con checkbox "Hoy" o selección manual
- Proveedor con autocompletado
- Nombre de archivo automático: `aa-mm-dd - proveedor.ext`
- Subida directa a Google Drive en carpeta correspondiente
- Cola offline con sincronización automática
- Historial de subidas recientes

## Setup
1. `npm install`
2. `npm run dev`
3. Abrir `http://localhost:5173`

## Deploy
Conectar el repo a Vercel. Se deploya automáticamente.

Después del deploy, agregar la URL de Vercel en Google Cloud Console:
- APIs y servicios → Credenciales → ArchiFactura
- Orígenes autorizados de JavaScript: `https://tu-app.vercel.app`
- URIs de redirección autorizados: `https://tu-app.vercel.app`
