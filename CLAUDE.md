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
- **Idioma**: todo el texto de cara al usuario (emails, pantallas de
  confirmación, mensajes del gate) está en inglés. El público es de Bay Area.
  Los comentarios del código también, según convención del proyecto.
- **Datos del formulario**: el gate manda `name`, `email`, `city`, `guests`,
  `month` y `message`. Solo los dos primeros son obligatorios; el resto se
  reenvía al email del owner para que pueda decidir sin tener que preguntar.
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
- **Charset explícito en los emails.** El HTML va envuelto en `emailLayout()`
  con `<meta charset="utf-8">` y la llamada a Resend declara
  `charset=utf-8`. Sin eso, los nombres con acento llegaban partidos
  ("Beltrán" se veía "Beltr?n") y solo se notaba en el dato del visitante,
  no en el texto fijo.
- **Rate limit por IP** en `request-access` (3/hora) y `verify` (10 cada 10 min).
  El CORS no cumple esa función: es una regla del navegador, y el request se
  procesa igual aunque el origen no esté permitido.
- **El campo del código lo construye el snippet, no el canvas.** En el diseño,
  "ENTER ACCESS CODE" es un link directo a /services sin ningún input. El
  script lo reemplaza por un `<input>` en tiempo de ejecución, copiando la
  tipografía computada del label que reemplaza. Si algún día se agrega un campo
  real en Framer, sacar `upgradeGate()` para que no se pisen.
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
- [x] Los 3 registros DNS cargados en GoDaddy (DKIM, SPF y MX en `send`)
- [x] Dominio verificado en Resend y envíos saliendo desde
      `acceso@txoko-dining.com` (esa casilla no existe ni necesita existir)
- [x] Circuito completo probado contra una casilla real, ida y vuelta:
      aprobación con código válido y rechazo con su email
- [x] `Reply-To` verificado: responder el aviso le escribe al solicitante
- [x] Copy migrado a inglés y los seis campos del formulario llegando al owner
- [x] Paths reales del sitio puestos en el snippet: `/services` es la página
      que abre el código y `/access-requested` el destino tras enviar el form
- [x] Charset verificado en producción: "Ignacio Beltrán" y "San Sebastián"
      renderizan bien en el email del owner
- [x] Snippet instalado en Framer (Site Settings → Code → "Txoko Gate",
      End of body, todas las páginas) y **sitio publicado**
- [x] Verificado en vivo sobre txoko-dining.com: código inválido rechazado con
      mensaje, código válido entra a /services, /services directo rebota al
      gate, y el formulario envía y redirige a /access-requested
- [x] CORS restringido a `SITE_URL`; el subdominio de Framer nunca se activó
- [ ] Cambiar `OWNER_EMAIL` al mail de Josü cuando esté todo aprobado
      (hoy apunta a la casilla de Dario para no molestarlo con pruebas)
- [ ] Nota de acceso: el CLI de Framer no puede abrir el proyecto porque está
      autenticado con la cuenta de Dario y el proyecto vive en el workspace de
      Josü. El trabajo se hizo por navegador con la sesión del owner.

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
