# Txoko — Backend de control de acceso

4 endpoints serverless en Vercel + Upstash Redis + Resend.

## Flujo

1. Visitante completa nombre + email en el gate → `POST /api/request-access`
2. Josü recibe email con botones **Aprobar** / **Rechazar**
3. Aprobar → se genera código único (`TXK-XXXX`), se guarda en KV y se envía al solicitante
4. Rechazar → email elegante de rechazo
5. El solicitante ingresa su código en el gate → `POST /api/verify` → entra al sitio

## Variables de entorno (Vercel → Settings → Environment Variables)

| Variable | Ejemplo | Qué es |
|---|---|---|
| `RESEND_API_KEY` | `re_xxxx` | API key de Resend (cuenta de Josü) |
| `FROM_EMAIL` | `Txoko <acceso@tudominio.com>` | Remitente (dominio verificado en Resend) |
| `OWNER_EMAIL` | `josu@...` | Email de Josü, recibe las solicitudes |
| `SITE_URL` | `https://tudominio.com` | Dominio del sitio (usado en CORS y emails) |
| `BASE_URL` | `https://txoko-backend.vercel.app` | URL de este deploy (para los links de aprobar/rechazar) |

No hace falta ningún secreto de admin: cada solicitud genera su propio token
único, que solo sirve para esa solicitud y se invalida al gestionarla.

Las variables de Redis (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`)
las inyecta Vercel automáticamente al vincular la base al proyecto.

## Deploy paso a paso

```bash
# 1. Login con el token de Josü (una sola vez)
vercel login --token TOKEN_DE_JOSU

# 2. Desde la raíz del proyecto, vincular (elegir cuenta/scope de Josü)
vercel link --token TOKEN_DE_JOSU

# 3. Deploy a producción
vercel --prod --token TOKEN_DE_JOSU
```

## Base de datos (Upstash Redis)

Vercel KV fue discontinuado en diciembre de 2024 y reemplazado por Upstash
Redis en el Marketplace de Vercel.

1. Dashboard de Vercel (cuenta de Josü) → proyecto → Storage
2. Marketplace → Upstash → Redis, misma región que Resend (us-east-1)
3. Conectarla al proyecto `txoko-backend`
4. Redeploy para que tome las variables

## Testing end-to-end

1. Con tu propio email: solicitar acceso desde el gate
2. Verificar que llega el email a Josü (o a tu mail si ponés el tuyo en `OWNER_EMAIL` para probar)
3. Click en Aprobar → verificar que llega el código
4. Ingresar el código en el gate → debe redirigir
5. Repetir con Rechazar
6. Probar código inválido → mensaje de error

## CORS

En `lib/utils.js` está la lista de orígenes permitidos. En producción solo
queda el dominio real. Para testear desde el subdominio de Framer, descomentar
la línea correspondiente y volver a comentarla antes del go-live.
