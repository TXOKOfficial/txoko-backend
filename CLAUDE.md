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
- **Todo mail lleva `Reply-To`.** `FROM_EMAIL` es una dirección del dominio
  verificado que no existe como casilla (Resend no lo necesita para enviar),
  así que sin `Reply-To` cualquier respuesta rebota en silencio. El aviso al
  owner responde al solicitante; los mails al solicitante responden al owner.
- **Token único por solicitud**, no un `ADMIN_SECRET` global. Si un mail se
  reenvía, ese token no sirve para gestionar ninguna otra solicitud.
- **Todo dato del visitante pasa por `escapeHtml()`** antes de entrar al HTML de
  un email. Sin eso, el campo "nombre" permite inyectar markup en el mail del
  owner, incluido un botón de aprobar falso.
- **Rate limit por IP** en `request-access` (3/hora) y `verify` (10 cada 10 min).
  El CORS no cumple esa función: es una regla del navegador, y el request se
  procesa igual aunque el origen no esté permitido.
- **La validación del código es server-side; la persistencia de la sesión es
  client-side.** Framer no expone control a nivel de request, así que la página
  interna no queda protegida por el servidor. Es una decisión tomada a
  conciencia: el gate cumple una función de filtro y de curaduría, no de
  resguardo. No poner detrás información que requiera protección real sin
  cambiar antes este esquema.

## Variables de entorno

| Variable | Qué es |
|---|---|
| `RESEND_API_KEY` | API key de Resend, permiso `Sending access` acotado al dominio |
| `FROM_EMAIL` | Remitente, ej: `Txoko <acceso@txoko-dining.com>` |
| `OWNER_EMAIL` | Casilla real que recibe las solicitudes |
| `REPLY_TO` | Opcional. Casilla a la que van las respuestas de los solicitantes. Si no se define, se usa `OWNER_EMAIL` |
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
- [x] Base Upstash Redis creada (`txoko-access`, iad1, sin eviction) y vinculada
- [x] Variables de entorno cargadas y deploy a producción funcionando
- [x] Circuito verificado de punta a punta con `onboarding@resend.dev`:
      solicitud → email → pantalla de confirmación → POST → código → `verify` OK.
      También verificado que el GET no aprueba, que el nombre se escapa, que un
      token inválido da 404 y que reabrir un link ya usado es idempotente.
- [ ] Cargar los 3 registros DNS de Resend en GoDaddy y verificar el dominio
- [ ] Pasar `FROM_EMAIL` a `Txoko <acceso@txoko-dining.com>` y `OWNER_EMAIL`
      a la casilla real (hoy están en valores de prueba)
- [ ] Pegar el snippet en Framer y ajustar selectores e `INNER_PATH`
- [ ] Probar el camino de rechazo
- [ ] Lockdown de CORS: sacar el subdominio de Framer de `ALLOWED_ORIGINS`

## Notas técnicas

- Vercel KV fue discontinuado en diciembre de 2024 y migrado a Upstash Redis en
  el Marketplace. El paquete `@vercel/kv` está deprecado.
- La región de un dominio en Resend no se puede cambiar después de crearlo: hay
  que borrarlo y darlo de alta de nuevo.
- En GoDaddy los nombres de registro se escriben en forma corta
  (`resend._domainkey`, no `resend._domainkey.txoko-dining.com`). GoDaddy le
  agrega el dominio solo.
- **El repositorio es público a propósito, no por descuido.** En el plan Hobby
  de Vercel, un repo privado solo deploya si el autor del commit es el dueño de
  la cuenta. Como los commits los firma un colaborador, hacerlo privado vuelve a
  romper todos los deploys. Vercel además cerró los atajos por CLI y deploy
  hooks. Si algún día se pasa a Pro, se puede volver a privado.
- No hay secretos en el repo: todo vive en variables de entorno de Vercel y el
  `.gitignore` cubre los `.env`. Mantener esa disciplina, ahora el código es
  público.
- Las integraciones se cablean siempre contra el dominio de producción, no
  contra entornos temporales, porque CORS y los templates lo referencian.
