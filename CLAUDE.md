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
  Keys: `request:{id}`, `pending:{email}`, `code:{CODE}`, `rl:{scope}:{ip}`,
  `lock:request:{id}`
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
- **Aprobar y rechazar mandan el mail antes de guardar el estado.** Si Resend
  falla, la solicitud queda `pending` (y el código se borra), así que el owner
  vuelve a apretar el botón y listo. Al revés quedaba marcada como aprobada con
  un código que nunca le llegó a nadie. Un lock corto (`lock:request:{id}`)
  evita que un doble click genere dos códigos.
- **Una solicitud repetida nunca se descarta en silencio.** Si el mismo email
  vuelve a pedir acceso con una solicitud pendiente, no se crea otra, pero se
  le reenvía el aviso al owner con los mismos links (como máximo cada 15 min).
  Antes se descartaba sin mandar nada y el visitante igual veía "enviado", lo
  que hacía parecer que el form no funcionaba.
- **Cada envío queda en los logs de Vercel** con el id de Resend. Ojo: en Hobby
  los logs duran 1 hora, así que diagnosticar hay que hacerlo en el momento o
  mirando Resend → Emails.
- **Rate limit por IP** en `request-access` (3/hora) y `verify` (10 cada 10 min).
  El CORS no cumple esa función: es una regla del navegador, y el request se
  procesa igual aunque el origen no esté permitido.
- **El campo del código lo construye el snippet, no el canvas.** En el diseño,
  "ENTER ACCESS CODE" es un link directo a /services sin ningún input. El
  script lo reemplaza por un `<input>` en tiempo de ejecución, copiando la
  tipografía computada del label que reemplaza. Si algún día se agrega un campo
  real en Framer, sacar `upgradeGate()` para que no se pisen.
- **El código se recuerda en el dispositivo.** Tras validarlo, el snippet lo
  guarda en `localStorage` y el visitante que vuelve salta el gate directo a
  /services. Se revalida contra `verify` una vez por pestaña y, si el backend
  dice que ya no existe, se olvida y vuelve al gate (un error de red o un 429
  no lo echa). `/?reset` lo borra, útil para probar.
- **Saludo con el nombre en /services.** `verify` devuelve el primer nombre
  guardado con el código y el snippet cambia "Welcome to" por
  "Dario, welcome to" (Framer ya lo muestra en mayúsculas). El nombre se guarda
  en `localStorage` junto al código; los códigos recordados antes de esto lo
  buscan solos en la siguiente revalidación. Si en Framer se cambia el texto
  "Welcome to", hay que actualizar `GREETING_PATTERN` en el snippet.
- **El campo del código es `type="password"`**, para que Chrome, Safari y los
  gestores ofrezcan guardarlo. Se ve con puntitos: Chrome ignora
  `-webkit-text-security: none` en campos de contraseña, así que no hay forma
  confiable de mostrarlo. En Chrome/Edge/Android además se pide guardar con
  `PasswordCredential`.
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
- [x] Campo del gate confirmado por el usuario en un navegador real: se puede
      clickear y escribir. Requirió dos arreglos: buscar la etiqueta por texto
      (la hidratación de Framer dejaba huérfano el elemento) y agrandar el área
      clickeable de 16px a 40px sin mover el layout
- [x] CORS restringido a `SITE_URL`; el subdominio de Framer nunca se activó
- [x] `OWNER_EMAIL` apunta al mail de Josü desde el 3/9 (con redeploy)
- [x] Fallos silenciosos corregidos (14/9): solicitud repetida reenvía el aviso,
      aprobar y rechazar ya no quedan a medias si falla el envío, logs de cada
      envío. Probado con Redis y Resend simulados
- [x] Código recordado en el dispositivo y guardable como contraseña: snippet
      reemplazado en Framer, publicado y confirmado por el usuario en un
      navegador real (15/9)
- [x] Saludo por nombre publicado y confirmado en vivo por el usuario:
      "IGNACIO, WELCOME TO" con el código de prueba (15/9)
- [ ] Probar para cada test un email distinto (ej. `hello+test1@dovvstudio.com`)
      o esperar 15 min: el mismo email pendiente no genera un aviso nuevo antes
- [ ] Nota de acceso: el CLI de Framer no puede abrir el proyecto porque está
      autenticado con la cuenta de Dario y el proyecto vive en el workspace de
      Josü (Dario figura como "Can view"). Reconfirmado el 15/9: el conector
      conecta con otros proyectos pero con TXOKO se corta por timeout. Los
      cambios al snippet los pega el usuario a mano en Site Settings → Code.

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
