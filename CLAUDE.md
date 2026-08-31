# CLAUDE.md — Txoko backend

## Qué es este proyecto

Backend de control de acceso para **Txoko**, una experiencia gastronómica privada en Bay Area. El acceso al sitio es por invitación: o tenés un código, o pedís uno y alguien lo aprueba a mano.

- **Sitio**: hecho en Framer. Una gate page (logo, input de código, botón "Request Access") que da paso a un sitio de scroll continuo.
- **Este repo**: los 4 endpoints serverless que gatean ese acceso.

## Arquitectura

```
Gate (Framer) ──POST──> /api/request-access ──email──> owner
owner abre "Aprobar"  ──> /api/approve (GET confirma, POST ejecuta)
                          └─> genera TXK-XXXXXX ──email──> solicitante
owner abre "Rechazar" ──> /api/reject  (GET confirma, POST ejecuta)
                          └─> email al solicitante
Gate (Framer) ──POST──> /api/verify ──> valida el código contra Redis
```

- **Hosting**: Vercel serverless functions
- **Storage**: Upstash Redis vía Marketplace de Vercel
  Keys: `request:{id}`, `pending:{email}`, `code:{CODE}`, `rl:{scope}:{ip}`
- **Emails**: Resend, API REST directa, sin SDK
- **Gestión de solicitudes**: por email, sin dashboard. Cada solicitud lleva su
  propio token en el link; no hay un secreto global de admin.

## Decisiones de diseño que conviene no revertir

- **Aprobar y rechazar confirman por POST.** El link del email solo muestra una
  pantalla con un botón. Gmail y Outlook visitan los links de los mails por su
  cuenta para escanearlos, así que un GET que ejecuta la acción termina
  aprobando solicitudes solo.
- **Token único por solicitud**, no un `ADMIN_SECRET` global. Si un mail se
  reenvía, ese token no sirve para gestionar ninguna otra solicitud.
- **Todo dato del visitante pasa por `escapeHtml()`** antes de entrar al HTML de
  un email. Sin eso, el campo "nombre" permite inyectar markup en el mail del
  owner, incluido un botón de aprobar falso.
- **Rate limit por IP** en `request-access` (3/hora) y `verify` (10 cada 10 min).
  El CORS no cumple esa función: es una regla del navegador, y el request se
  procesa igual aunque el origen no esté permitido.
- **El gate no es una barrera real.** La página interna se protege con
  `sessionStorage` del lado del cliente, así que se puede entrar por URL directa.
  Es deliberado: Framer no ofrece control server-side, y el objetivo acá es
  filtrar y dar noción de privado, no proteger información sensible.

## Variables de entorno

| Variable | Qué es |
|---|---|
| `RESEND_API_KEY` | API key de Resend, permiso `Sending access` acotado al dominio |
| `FROM_EMAIL` | Remitente, ej: `Txoko <acceso@txoko-dining.com>` |
| `OWNER_EMAIL` | Casilla que recibe las solicitudes |
| `SITE_URL` | Dominio real del sitio, usado en CORS y en los emails |
| `BASE_URL` | URL de este deploy en Vercel, usada en los links de gestión |

Upstash inyecta las suyas (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`)
al vincular la base al proyecto. `lib/utils.js` también acepta las viejas
`KV_REST_API_*` por si la base quedó vinculada con el prefijo anterior.

## Estado técnico

- [x] Los 4 endpoints escritos y validados
- [x] Hardening: escape de HTML, confirmación por POST, token por solicitud,
      rate limit por IP, migración de `@vercel/kv` a `@upstash/redis`
- [x] Dominio `txoko-dining.com` dado de alta en Resend (región `us-east-1`,
      inmutable) y API key generada
- [ ] Cargar los 3 registros DNS de Resend en GoDaddy y verificar el dominio
- [ ] Crear la base Upstash Redis y vincularla al proyecto
- [ ] Cargar variables de entorno en Vercel
- [ ] Deploy a producción
- [ ] Pegar el snippet en Framer y ajustar `API_BASE`, selectores y `INNER_PATH`
- [ ] Testing end-to-end: solicitar → aprobar → código → entrar, y el rechazo
- [ ] Lockdown de CORS: sacar el subdominio de Framer de `ALLOWED_ORIGINS`

## Notas técnicas

- Vercel KV fue discontinuado en diciembre de 2024 y migrado a Upstash Redis en
  el Marketplace. El paquete `@vercel/kv` está deprecado.
- La región de un dominio en Resend no se puede cambiar después de crearlo: hay
  que borrarlo y darlo de alta de nuevo.
- En GoDaddy los nombres de registro se escriben en forma corta
  (`resend._domainkey`, no `resend._domainkey.txoko-dining.com`). GoDaddy le
  agrega el dominio solo.
- Las integraciones se cablean siempre contra el dominio de producción, no
  contra entornos temporales, porque CORS y los templates lo referencian.
