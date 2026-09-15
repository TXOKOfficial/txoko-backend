# Txoko · Access system

Handover document. It explains how the Txoko site and its backend work, so
anyone can pick up the project without prior context.
The detailed history of decisions lives in `CLAUDE.md` (in Spanish).

---

## 1. What it is

Txoko is a private dining experience in the Bay Area. Its website is invitation
only: entering requires an access code. Visitors without one can request it, and
the owner approves or declines each request by hand from their inbox.

The system has three parts:

| Part | Where it lives | What it does |
|---|---|---|
| Site | Framer, at `txoko-dining.com` | design and content for every page |
| Snippet | `framer-gate-snippet.html`, pasted into Framer | connects the site to the backend |
| Backend | this repo, on Vercel (`txoko-backend.vercel.app`) | stores requests and codes, sends the emails |

---

## 2. A visitor's journey

```
1. Opens txoko-dining.com              → sees the gate (logo + code field)

2. Has no code                         → fills in the form at /request-access
   snippet → POST /api/request-access  → email to the owner with Approve / Decline
   the visitor lands on /access-requested

3. The owner presses Approve           → /api/approve generates TXK-XXXXXX
                                         and emails it to the visitor
   or presses Decline                  → /api/reject sends a decline email

4. The visitor types the code          → snippet → POST /api/verify
                                         if valid, they enter /services

5. Comes back another day              → the browser remembers the code
                                         and goes straight in

6. Sends "Request a Consultation"      → snippet → POST /api/consultation
   from /services                        email to the owner saying this person
                                         already has access (no Approve / Decline)
                                         the form is replaced by a thank you
```

---

## 3. Framer pages

| Path | What it is |
|---|---|
| `/` | the gate: logo, code field and a link to request access |
| `/request-access` | native Framer form: name, email, city, guests, preferredMonth, message |
| `/access-requested` | confirmation shown after the form is sent |
| `/services` | the inner page, the actual site. Its "Request a Consultation" form is the same Framer form as `/request-access` |

---

## 4. The snippet

Framer does not allow custom logic inside the design, so all the behaviour lives
in a script pasted into
**Framer → Site Settings → Code → "Txoko Gate"** (End of body, all pages).

It does seven things:

1. **Builds the code field.** In the design, "ENTER ACCESS CODE" is just a text
   with a link. The script swaps it for a real input when the page loads.
2. **Sends the form** on `/request-access` to the backend.
3. **Sends back to the gate** anyone who opens `/services` without a verified code.
4. **Remembers the code** in the browser. Opening `txoko-dining.com/?reset`
   clears it, which is handy for testing.
5. **Greets by name**: on `/services` it turns "Welcome to" into
   "Name, welcome to".
6. **Sends the consultation form** on `/services` to `/api/consultation` and
   shows a thank you in place of the form.
7. **Shows the hand cursor on every button.** Framer nests a `<button>` inside
   each link, and the browser's default arrow cursor on it hid the link's hand.

The script finds elements by their text. **If any of these texts or paths change
in Framer, the snippet must be updated:**

| If this changes in Framer | Update in the snippet |
|---|---|
| the text "ENTER ACCESS CODE" | `findGateLabel()` |
| the text "Welcome to" | `GREETING_PATTERN` |
| the paths `/services` or `/access-requested` | `INNER_PATH`, `REQUESTED_PATH` |
| the form field names | `FIELD_MAP` |

The file in this repo is the source of truth. Framer does not read it from here:
edit it in the repo, paste it into Framer by hand, then publish the site.

---

## 5. The backend

Five serverless functions in `api/` plus shared helpers in `lib/utils.js`.

| Endpoint | Called by | What it does |
|---|---|---|
| `POST /api/request-access` | the form | validates, stores the request and notifies the owner |
| `GET` and `POST /api/approve` | link in the owner's email | GET shows a confirm button; POST generates the code and sends it |
| `GET` and `POST /api/reject` | link in the owner's email | same as approve, but sends the decline email |
| `POST /api/verify` | the gate | answers whether the code is valid and returns the first name |
| `POST /api/consultation` | the form on `/services` | emails the owner a consultation, confirming against Redis whether the sender already has access. Stores nothing |

### Services

| Service | Used for |
|---|---|
| Vercel (Hobby plan) | hosting the functions |
| Upstash Redis | database, connected through Vercel → Storage |
| Resend | sending emails from `acceso@txoko-dining.com` (that mailbox does not exist and does not need to) |
| GoDaddy | domain and DNS, with the Resend records in place |

### Data stored in Redis

| Key | Contents | Lifetime |
|---|---|---|
| `request:{id}` | the request: form data, token and status (`pending`, `approved`, `rejected`) | 30 days if nobody handles it; kept once handled |
| `pending:{email}` | id of that email's pending request | removed once handled |
| `code:{CODE}` | email, name, approval date, number of uses | never expires |
| `rl:request:{ip}`, `rl:consultation:{ip}`, `rl:verify:{ip}` | rate limit counters | 1 hour, 1 hour and 10 minutes |
| `lock:request:{id}` | stops a double click from approving twice | 60 seconds |

### Environment variables

Set in **Vercel → project → Settings → Environment Variables**. After changing
any of them, run a **Redeploy**.

| Variable | What it is |
|---|---|
| `RESEND_API_KEY` | Resend API key, sending access only |
| `FROM_EMAIL` | sender, `Txoko <acceso@txoko-dining.com>` |
| `OWNER_EMAIL` | real inbox that receives the requests |
| `REPLY_TO` | optional; where visitors' replies go. Falls back to `OWNER_EMAIL` |
| `SITE_URL` | `https://txoko-dining.com`, used for CORS and in the emails |
| `BASE_URL` | `https://txoko-backend.vercel.app`, used in the approve and decline links |
| `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` | added by Vercel automatically when the database is connected |

---

## 6. Deploy

Every push to `main` on GitHub deploys to Vercel automatically. There is no
build step and no tests; the only dependency is `@upstash/redis`.

**The repo must stay public.** On the Hobby plan, a private repo only deploys
commits made by the owner of the Vercel account, so making it private breaks
every deploy. For the same reason there are no secrets in the code: everything
sensitive lives in environment variables.

---

## 7. Common tasks

| I want to | How |
|---|---|
| change the inbox that receives requests | `OWNER_EMAIL` in Vercel, then Redeploy |
| change the wording of an email | edit `api/approve.js`, `api/reject.js`, `api/request-access.js` or `api/consultation.js` and push |
| revoke someone's access | Vercel → Storage → open Upstash → Data Browser → delete `code:TXK-...`. Their browser forgets it on the next visit |
| see who requested access | Upstash → Data Browser, search `request:*` |
| check whether an email went out | Resend → Emails. Vercel logs on Hobby only last 1 hour |
| test the whole flow | use a different email for each test (`name+test1@...`): an email with a pending request does not notify the owner again for 15 minutes |
| change the snippet | edit `framer-gate-snippet.html`, paste it into Framer and publish |

---

## 8. Decisions worth keeping

- **Approve and Decline ask for a button press.** Gmail and Outlook open links
  in emails on their own to scan them; if the link acted directly, requests
  would get approved with nobody touching anything.
- **Each request carries its own token** in the links. There is no admin
  password: if an email is forwarded, its links cannot manage any other request.
- **The email is sent first, the status saved after.** If sending fails, the
  request stays pending and pressing the button again is enough.
- **Everything the visitor types goes through `escapeHtml()`** before it reaches
  an email. Without it, someone could inject a fake button into the owner's email.
- **Every email has a Reply-To.** The sender is not a real mailbox, so without it
  replies would be lost. Replying to a request notice writes to the visitor;
  replying to a code email writes to the owner.
- **Rate limits per IP**: 3 requests per hour and 10 code attempts every
  10 minutes. CORS is not a protection, only browsers honour it.

---

## 9. Known limits

- **The gate filters, it does not protect.** Framer offers no server side access
  control, so `/services` can be reached with the URL and some technical
  knowledge. Do not put anything there that needs real protection.
- **Codes never expire and are not tied to a person.** They can be shared. This
  is a deliberate choice: the gate is a curation filter.
- **The code field shows dots** instead of letters, because it is a password
  field. That way the browser offers to save the code.

---

## 10. Access

Every account belongs to the client. To work on the project, ask them for:

| Account | What to ask for |
|---|---|
| Framer | Full Access to the project (view only access cannot edit the snippet or publish) |
| GitHub | collaborator on `TXOKOfficial/txoko-backend` |
| Vercel | the Hobby plan does not allow team members; coordinate with the owner |
| Resend | account access, to check deliveries |
| GoDaddy | delegate access, "Products & Domains" level, only if DNS needs changing |
