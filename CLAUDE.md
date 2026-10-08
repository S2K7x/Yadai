# CLAUDE.md — Yadai

Interface web privée mono-utilisateur pour **Hermes Agent**, façon Claude.ai,
tournant sur un Raspberry Pi 5. SvelteKit (adapter-node) + SQLite, exposée sur
le tailnet par Tailscale Serve.

## Deux noms, et la frontière entre eux

**Yadai** est le produit : le titre de l'onglet, le manifeste PWA, l'icône, et
tout ce qu'une phrase française affichée à l'écran appelle par son nom.
**Hermes** est le moteur qu'il pilote, et ce nom-là ne se traduit pas — il
désigne des choses qui existent en dehors de ce dépôt et qu'on ne peut pas
renommer sans mentir sur ce qu'on adresse :

| Reste `hermes` | Pourquoi |
|---|---|
| `HERMES_API_KEY`, `HERMES_DASHBOARD_*`, `HERMES_SESSION_KEY`, `HERMES_*` | lues depuis `.env`, hors dépôt et intouchable |
| `X-Hermes-Session-Key` / `-Id` / `-Token` | en-têtes du protocole amont |
| `~/.hermes/`, `/mnt/data/hermes/hermes-agent/` | l'état et les sources de Hermes |
| `hermes-gateway`, `hermes-dashboard` | unités systemd utilisateur |
| `data/hermes-web.db` | la base **vivante** : la renommer orpheline prefs, prompts, agents, titres et abonnements push |
| `/opt/stacks/Hermes-Ui`, `/mnt/data/backups/hermes*` | chemins de déploiement et archives déjà écrites |
| `HermesSession`, `HermesJob`, `HermesError`, `lib/server/hermes.ts` | types et client de **l'API de Hermes** — les renommer dirait qu'on parle à autre chose |

La règle pratique : **une chaîne lue par un humain dit « Yadai » ; un
identifiant qui voyage vers Hermes ou vers le disque garde son nom.** Une
question utile avant de renommer quoi que ce soit : est-ce que quelqu'un doit
taper ça quelque part ? Si oui, ce n'est pas à nous de le changer.

Les clés `localStorage` ont, elles, suivi le produit (`yadai-*`) : elles
n'appartiennent qu'au navigateur. `legacyKey()` (`src/lib/client/storage.ts`,
pure et testée) déplace une ligne `hermes-*` vers son nouveau nom à la première
lecture, pour qu'un brouillon à moitié tapé survive au changement de nom.

## Le point essentiel

**Hermes n'est pas modifié.** Tout passe par son serveur API OpenAI-compatible
déjà intégré (`127.0.0.1:8642`). Cette UI est un client de la **Sessions API**
(`/api/sessions/*`), qui fournit gratuitement la sidebar, l'historique et le
fork. Ne jamais patcher `/mnt/data/hermes/hermes-agent/` pour un besoin de
l'UI — si quelque chose manque, c'est un contournement côté client.

## Architecture

```
Navigateur / PWA
   │  HTTPS via Tailscale Serve (<machine>.<tailnet>.ts.net)
   ▼
SvelteKit adapter-node — 127.0.0.1:3000  (conteneur Docker)
   ├── src/routes/api/**      proxy de confiance : injecte le Bearer
   ├── src/lib/server/turns.ts tours en vol (survivent au départ du client)
   ├── data/hermes-web.db     prefs, prompts, thème, titres, agents, push
   └── /skills                bind mount de ~/.hermes/skills (éditeur de skills)
   │
   ├─ HTTPS sortant → service de push (Apple / Google / Mozilla)
   │     └── notification chiffrée quand un tour finit sans spectateur
   │
   ├─ HTTP loopback + Authorization: Bearer
   │  ▼
   │  Hermes gateway (systemd --user hermes-gateway) — 127.0.0.1:8642
   │     └── ~/.hermes/state.db  sessions, transcripts, mémoire ← source de vérité
   │
   └─ HTTP loopback + X-Hermes-Session-Token
      ▼
      Hermes dashboard (systemd --user hermes-dashboard) — 127.0.0.1:9119
         └── ~/.hermes/.env + config.yaml  identifiants des providers
```

Deux serveurs amont, deux secrets distincts, deux rôles : le **gateway** fait
tourner l'agent, le **dashboard** configure Hermes. Aucun des deux ne doit être
patché — voir le point 13 pour ce que ça implique côté providers.

Le navigateur ne parle **jamais** directement à Hermes. `HERMES_API_KEY` reste
côté serveur ; aucune route ne la renvoie, aucun `$env/static/public` ne la
contient.

## Ce qu'il faut savoir avant de toucher au code

Ces points ont tous été vérifiés contre l'implémentation réelle
(`gateway/platforms/api_server.py`), pas contre la doc.

### 1. Le champ `model` d'une session doit être un vrai identifiant

`GET /v1/models` ne renvoie que le nom **virtuel** `hermes-agent`. Si on crée
une session avec ce nom, Hermes le persiste sur la ligne de session puis le
renvoie tel quel au fournisseur, et chaque tour échoue avec
`HTTP 400: hermes-agent is not a valid model ID`.

La liste réelle est dans `GET /api/model/options` (champs `model` = défaut
courant, `providers[].models`). `src/routes/api/sessions/+server.ts` résout
systématiquement ce défaut avant de créer une session.

### 2. Un tour de la Sessions API ne peut pas être interrompu

Deux constats **mesurés**, pas déduits de la doc :

1. `POST /v1/runs/{run_id}/stop` ne connaît que les runs soumis par
   `POST /v1/runs` — seul ce chemin enregistre l'agent dans
   `_active_run_agents`. Le `run_id` émis par
   `/api/sessions/{id}/chat/stream` n'y est pas : le stop répond 404.
2. Couper le flux SSE n'annule pas le run non plus. Le handler appelle bien
   `task.cancel()` quand une écriture échoue, mais ça n'arrive jamais à temps.
   Test : tour coupé à 6 s → l'agent a quand même exécuté ses 3 appels
   `terminal` et persisté sa réponse ~25 s plus tard.

**Conséquence assumée dans l'UI** : le bouton carré *détache* l'affichage. Il
pose `detached` sur le tour, affiche une explication et un bouton
« Recharger » (`chat.reload()`), puisque la réponse finira dans `state.db` de
toute façon. Ne pas rebaptiser ça « Stop » ni tenter `/v1/runs/*/stop`.

Côté serveur, cette même mesure est ce qui justifie le point 16 : puisque
l'agent finit son travail de toute façon, le serveur suit le tour jusqu'au bout
au lieu de couper le `fetch` amont.

**Et l'alternative Runs API ?** Elle donne un vrai stop *et* les événements
d'approbation, mais elle a été testée et rejetée : `POST /v1/runs` accepte un
`session_id` et persiste bien le transcript, mais **ne recharge pas
l'historique de la session** — au deuxième tour l'agent répond « il n'y a pas
de question précédente ». Il faudrait lui repasser `conversation_history`, que
le handler aplatit en `str(content)` : adieu les `tool_calls` structurés et le
multimodal. Le multi-tours fidèle vaut plus que le bouton stop.

### 3. Le modèle d'une session se change — via `POST /api/sessions/{id}/model`

Hermes épingle bien un modèle sur la ligne de session à la création, mais ce
n'est pas définitif : `_handle_session_model_lock` force `require_model_lock`,
écrit un `browser_model_lock` **confirmé** dans le `model_config` de la session
et met à jour la colonne `model` (`model = COALESCE(?, model)` dans
`hermes_state.update_session_runtime_lock`). Chaque tour suivant résout son
runtime par `_effective_session_runtime_request`, où un verrou confirmé passe
**avant** la colonne `model`. Le changement s'applique donc à la conversation
ouverte, dès le message suivant.

`chat.setModel()` fait les deux : il mémorise le choix pour les nouvelles
discussions (`nextModel`, persisté en localStorage) et, si une conversation est
ouverte, pose le verrou dessus. `chat.activeModel` est ce que le sélecteur
affiche : le modèle de la session ouverte, sinon `nextModel`.

**Les trois choix qu'une conversation porte passent par le même chemin.** Le
modèle (ici), l'agent (point 18) et l'effort de réflexion (point 34) se
choisissent de façon identique : mémoriser le choix pour les nouvelles
discussions, poser la valeur sur la ligne de session par optimisme, l'envoyer,
et **rendre les deux moitiés** si l'amont refuse. C'était trois copies de cet
algorithme, dont deux annonçaient en commentaire « même forme que
`setModel()` » — d'où `#choose()` (`stores/chat.svelte.ts`), que
`SessionChoice<T>` décrit et que les trois `set*()` remplissent. La moitié
qu'une copie oublie est la préférence : un choix refusé laissé en localStorage
serait épinglé sur la discussion suivante, où il ferait échouer chaque tour
(point 1). `tests/choices.test.ts` relit la source pour qu'aucune des trois ne
reprenne sa propre requête ni son propre `catch`.

Deux pièges :

- Hermes **refuse** un modèle qu'il ne sait pas router (409
  `model_lock_unavailable`) plutôt que de retomber en silence sur le défaut
  global. Un rejet veut dire que le choix est inutilisable : `setModel()`
  annule alors aussi bien la ligne de sidebar que `nextModel`.
- La capacité est annoncée dans `GET /v1/capabilities` sous
  `features.session_model_lock`. L'UI se cale dessus (`chat.canSwitchModel`) et
  retombe sur l'ancien discours — « ce choix s'appliquera à la prochaine
  discussion » — si le gateway ne l'expose pas. Ce constat vient de la lecture
  d'`api_server.py` (0.20.0), pas d'une mesure sur un tour réel : à vérifier en
  relecture.

### 4. `X-Hermes-Session-Key` doit être stable

C'est le scope de la mémoire long-terme (Honcho / FTS5). Il est fixé une fois
pour toutes dans `HERMES_SESSION_KEY` (`agent:main:webui:dm:user`) et injecté
par `hermes.ts` sur chaque appel. S'il suivait `session_id`, la mémoire se
fragmenterait à chaque « nouvelle discussion ». Ne pas le rendre dynamique.

### 5. Pas d'upload de fichiers — images en pièce jointe, texte dans le prompt

L'API accepte `image_url` en URL `http(s)` ou `data:image/...;base64`. Tout le
reste (`file`, `input_file`, `file_id`, `data:` non-image) est rejeté en
`400 unsupported_content_type`. `Composer.svelte` filtre côté client et
affiche pourquoi, plutôt que de laisser le tour échouer.

**Mais un fichier texte n'a pas besoin d'être une pièce jointe** : le prompt
est un canal que l'API a toujours accepté. Tout ce qui n'est pas une image et
qui se lit comme du texte est donc **inséré dans le message** en bloc de code,
avec son nom au-dessus — ce que l'utilisateur faisait à la main en ouvrant le
fichier ailleurs. Rien de nouveau n'est demandé à Hermes : ce qui part est le
même prompt qu'avant.

Les règles sont dans `src/lib/attach.ts` (pur, testé) :

- **Le tri se fait sur le contenu, pas sur l'extension.** `File.text()` décode
  en UTF-8 ce qu'on lui donne, donc un JPEG revient en chaîne — pleine de NUL
  et de U+FFFD. `looksBinary()` juge le texte décodé (2 % de contrôles ou de
  caractères de remplacement sur les 4 premiers ko), ce qui laisse passer
  `Dockerfile`, `Makefile` et `.env.example` sans liste à tenir à jour.
- **Deux plafonds, et un refus plutôt qu'une troncature.** 512 Ko sur les
  octets, avant tout décodage (une vidéo déposée est refusée sur sa taille, pas
  après cent mégaoctets passés dans un décodeur), puis 60 000 caractères sur le
  texte. Un bloc arrivé à moitié serait répondu à moitié sans que rien ne le
  dise — même raisonnement que `MAX_DRAFT_CHARS` au point 25.
- **La clôture est plus longue que ce qu'elle enferme** : `fenceFor()` compte
  les backticks en tête de ligne du fichier, donc un `.md` qui cite ``` ne
  referme pas le bloc par le milieu.
- Le tag de langage ne sort que de la liste que `highlight.js/lib/common`
  enregistre vraiment (point 9) : une extension inconnue ne donne **aucun**
  tag, jamais une supposition.
- L'`<input type="file">` n'a plus d'`accept` : sur iOS un filtre étroit est ce
  qui cache l'app Fichiers derrière la photothèque.

### 6. `PATCH /api/sessions/{id}` n'accepte que 4 champs

`title`, `pinned`, `archived`, `end_reason`. Tout autre champ → 400
`unsupported_session_field`. Le proxy filtre explicitement. Le modèle ne passe
pas par là mais par `POST /api/sessions/{id}/model` (point 3). Poser
`archived` est accepté, mais rend la conversation invisible à toute liste —
voir le point 12.

### 7. Le fork ferme le parent

`POST /api/sessions/{id}/fork` reprend la sémantique `/branch` du CLI : le
parent passe en `end_reason = "branched"` et l'enfant hérite du transcript.
Après un fork il faut donc rafraîchir **les deux** lignes de la sidebar
(`chat.forkSession` refait un `refreshSessions()` complet).

### 8. Les approbations ne remontent pas ici — et ce qui se passe à la place

`approval.request` n'est émis que sur le flux d'événements de la Runs API. La
Sessions API ne propage que `tool.started` / `tool.completed` / `tool.failed`
et `tool.progress`. Une UI d'approbation impliquerait de basculer le chemin
d'envoi sur `POST /v1/runs` + `GET /v1/runs/{id}/events`, ce qui ferait perdre
la persistance native du transcript. Choix assumé : pas d'approbation dans
l'UI web.

**Ce que ça donne concrètement**, re-mesuré contre 0.20.0 après qu'un
utilisateur soit tombé dessus. `check_all_command_guards`
(`tools/approval.py`) cherche un callback de notification par session — celui
qui affiche un vrai bouton Approuver/Refuser sur Telegram, Discord ou le CLI.
**Le chemin Sessions n'en enregistre aucun** : `register_gateway_notify` n'est
appelé que par `_handle_create_run`. La garde prend donc sa branche de repli,
enregistre la demande avec `submit_pending(session_key, …)` et **rend la main
immédiatement** :

```
{approved: false, status: "pending_approval", approval_pending: true,
 command: "…", description: "…",
 message: "⚠️ <description>. Asking the user for approval.\n\n**Command:**…"}
```

Rien ne bloque. L'agent lit ça comme résultat d'outil, raconte en général
qu'il attend une approbation, et le tour se termine normalement. **Quand
l'utilisateur lit le message, il n'y a plus rien à accorder** : la demande
n'attend pas, elle est déjà retombée. C'est pour ça qu'un bouton « Approuver »
serait un mensonge et pas un raccourci.

`POST /v1/runs/{run_id}/approval` (choix `once | session | always | deny`)
résout via `self._run_approval_sessions[run_id]`, une table que seul
`POST /v1/runs` remplit : un tour de conversation n'y a pas d'entrée et
l'endpoint répond 404 `Run has no active approval session`.

**Pourquoi ça n'arrive qu'une fois de temps en temps.** `approvals.mode` vaut
`smart` par défaut : un modèle auxiliaire juge la commande et approuve la
plupart. Et son échec n'est pas neutre —
`except Exception: logger.debug("Smart approvals: LLM call failed, escalating");
return "escalate"`. Un modèle auxiliaire indisponible transforme donc une
commande normalement auto-approuvée en demande d'approbation que personne ne
peut satisfaire ici. La fiabilité de `auxiliary.*` gouverne la fréquence de
cette impasse bien plus que quoi que ce soit dans cette app.

**Ce que l'UI fait, faute de mieux** : `src/lib/approvals.ts` (pur, testé
contre une capture réelle de la garde) reconnaît ce résultat d'outil et
`Message.svelte` affiche un bloc qui nomme l'impasse, montre la commande et
dit par où passer. La détection s'accroche au marqueur amont
`Asking the user for approval` : si la phrase change, le bloc disparaît — il
ne fabrique jamais un contrôle qui ne fait rien.

**La liste d'autorisations permanente** (`command_allowlist` dans
`config.yaml`, écrivable via `PUT /api/config` du dashboard) ne rattrape pas
le coup à chaud : `load_permanent_allowlist()` n'est appelé qu'**une fois à
l'import du module**, donc un ajout ne prend effet qu'au redémarrage du
gateway.

### 9. Le rendu markdown est débouncé, et la cadence dépend de la longueur

Un parse markdown complet à chaque token sature le CPU du Pi. `Markdown.svelte`
re-parse sur un minuteur pendant le stream, puis une fois immédiatement à la
fin. `closeOpenConstructs()` équilibre les fences, le gras et les liens
tronqués pour que le texte partiel s'affiche comme ce qu'il est en train de
devenir. La coloration syntaxique n'est appliquée qu'aux messages terminés.

**Le délai n'est pas fixe, parce que le coût d'un rendu ne l'est pas.** Un
rendu re-parse tout le tampon, re-assainit toute la sortie et donne à
`{@html}` un sous-arbre qui remplace intégralement le précédent — trois coûts
linéaires en la longueur de la réponse, qui ne fait que grandir. **Mesuré sur
ce Pi 5**, en Chromium headless, un rendu + échange DOM complet :

| message | parse + sanitize | échange DOM | total | part d'un cœur à 70 ms |
|---|---|---|---|---|
| 1,9 ko | 1,4 ms | 1,3 ms | 2,8 ms | 4 % |
| 5 ko | 2,7 ms | 3,0 ms | 5,7 ms | 8 % |
| 10 ko | 4,8 ms | 5,7 ms | 10,6 ms | 15 % |
| 20 ko | 8,8 ms | 11,5 ms | 20,3 ms | 29 % |
| 34 ko | 14,5 ms | 18,7 ms | 33,2 ms | 47 % |

Environ 1 ms par kilo-octet, dont plus de la moitié à reconstruire du DOM qui
n'a pas changé — sur le CPU qui fait justement tourner l'agent en train
d'écrire la réponse. À cadence fixe, le coût d'affichage d'un tour long croît
donc sans borne alors que chaque redessin n'apporte que quelques tokens de
plus.

D'où `renderDelayMs(chars)` (pur, testé) : le délai grandit avec le message —
`chars / 100`, borné à `RENDER_DEBOUNCE_MS` (70 ms) et
`MAX_RENDER_DEBOUNCE_MS` (300 ms) — pour que le **rythme** de travail reste
plat, autour d'un dixième de cœur quelle que soit la longueur. Les réponses
courtes, c'est-à-dire la grande majorité, restent exactement au plancher de
70 ms ; une réponse de 20 ko se redessine toutes les 204 ms au lieu de 70 ms.
Le plafond n'est pas un budget mais un plancher de réactivité : au-delà de
~30 ko la machine à écrire doit continuer d'avancer même si ça coûte plus que
la cible.

Sur un tour entier — texte arrivant à 120 caractères par seconde, rendus
rejoués pour de vrai dans Chromium sur ce Pi — ça donne le CPU total dépensé à
afficher une réponse pendant qu'elle s'écrit :

| réponse | durée du tour | avant | après |
|---|---|---|---|
| 3,7 ko | 31 s | 1,10 s | 1,02 s |
| 10 ko | 85 s | 6,4 s | 5,8 s |
| 20 ko | 170 s | 23,9 s | 13,7 s |
| 34 ko | 287 s | 64,8 s | 24,4 s |

Autrement dit : les réponses courtes ne bougent pas (elles sont au plancher),
et une longue rend 40 secondes de cœur au Pi — celui-là même qui fait tourner
l'agent.

Ce que ça ne change pas : le rendu final est toujours immédiat et non débouncé,
donc le texte affiché à la fin d'un tour est le même qu'avant, à la même
milliseconde. Seule la fréquence des états intermédiaires baisse — et le
curseur clignotant reste ce qui dit que du texte arrive entre deux parses.

**Et un redessin ne repart plus du début du message.** Baisser la cadence ne
changeait rien au fait que *chaque* passe refaisait tout : re-parser le tampon
entier, ré-assainir toute la sortie, remplacer l'intégralité du sous-arbre —
alors que la seule chose qui avait bougé depuis la passe précédente était le
dernier paragraphe.

`stablePrefixEnd()` (`src/lib/markdown.ts`, pure et testée) coupe donc le
tampon au **dernier** endroit où markdown garantit que les deux moitiés se
rendent comme elles se rendraient ensemble : une ligne qui, à la colonne 0 et
après une ligne vide, ne peut que *commencer* un bloc — un titre ATX, une
ouverture de bloc de code, un filet horizontal. Aucun des trois ne peut
continuer le bloc du dessus, et chacun clôt tout conteneur encore ouvert
(liste, tableau, citation) : ce qui précède se rend donc à l'identique, seul
ou suivi du reste. `Markdown.svelte` parse cette tête **une fois par section**
et laisse son DOM tranquille ; seule la queue est refaite à chaque tick.

Trois choses qui rendent ça sûr, et qu'il ne faut pas défaire :

- **Un message terminé n'est jamais coupé.** Le rendu final reste une passe
  unique sur tout le tampon, comme avant. Le pire qu'une coupure mal choisie
  puisse coûter est donc un instant d'affichage bancal *pendant* le stream,
  corrigé à la milliseconde où le tour se termine.
- **Deux constructions font abandonner la coupure** pour le reste du message
  (retour `-1`, et retour au comportement d'avant) : une **définition de lien
  de référence** (`[doc]: https://…`), qui se déclare n'importe où et s'utilise
  n'importe où — donc change ce qui est déjà à l'écran —, et un **bloc HTML
  brut**, dont la balise ouvrante peut se fermer plusieurs blocs plus loin et
  dont les deux moitiés seraient assainies séparément.
- `assistant.completed` **remplace** le tampon au lieu de l'allonger
  (point ci-dessus sur l'autorité de cette trame), et peut arriver alors que
  `streaming` est encore vrai. D'où le `source.startsWith(headSrc)` avant
  toute réutilisation : un memcmp, contre des millisecondes de parsing.

**Mesuré sur ce Pi**, tour entier rejoué (texte à 120 caractères/seconde,
cadence du debounce ci-dessus, `marked` réellement appelé) :

| réponse | markdown parsé | HTML livré à `{@html}` | CPU de parsing |
|---|---|---|---|
| 4 ko | 1,05 Mo → 0,11 Mo | 1,44 Mo → 0,15 Mo | −88 % |
| 10 ko | 5,63 Mo → 0,45 Mo | 7,73 Mo → 0,62 Mo | −92 % |
| 20 ko | 13,8 Mo → 1,44 Mo | 18,9 Mo → 1,98 Mo | −90 % |
| 34 ko | 25,4 Mo → 3,77 Mo | 34,9 Mo → 5,19 Mo | −86 % |

L'assainissement et l'échange DOM sont linéaires dans ces mêmes octets — c'est
la mesure du tableau du dessus —, donc les deux autres tiers du coût baissent
dans la même proportion. Une réponse courte sans titre ni bloc de code ne coupe
rien du tout et se comporte exactement comme avant.

**Le post-traitement d'un message terminé doit attendre `tick()`.** `tail` est
affecté *depuis* un effet, donc quand l'effet suivant s'exécute Svelte n'a pas
encore écrit `{@html tail}` dans le DOM : lire `container` à ce moment-là
décore le balisage **précédent**, que l'échange à venir jette. C'est ce qui
faisait que ni la coloration syntaxique ni le bouton « copier » n'apparaissaient
jamais. **Mesuré sur l'app en production** avant correction : un transcript
affichant 13 blocs de code contenait zéro `span.hljs-*`, aucun `data-hl` et zéro
bouton. Ne pas retirer ce `tick()`.

**Et les grammaires de coloration sont chargées à la demande.**
`highlight.js/lib/common`, ce sont 37 langages qui construisent tous leurs
objets `RegExp` à l'initialisation du module. Mesuré : 164 Ko du chunk d'entrée
(389 Ko → 226 Ko brut, 103 Ko → 65 Ko en brotli) et 48 ms d'initialisation sur
le CPU du Pi — contre 22 ms pour `marked` + `dompurify` réunis — payés à chaque
ouverture de l'app, y compris pour une conversation sans une ligne de code. Et
tant que le bug ci-dessus vivait, payés pour **rien du tout**.

D'où un `import()` dynamique dans `src/lib/markdown.ts`, avec trois
conséquences dans le code :

- `highlightCodeBlocks()` **ne fait rien** tant que le paquet n'est pas
  résident, et ne pose alors pas `data-hl` : c'est l'appelant qui rejoue après
  `loadHighlighter()`. Ne pas supposer la coloration synchrone.
- Pour éviter le clignotement « code brut puis coloré », `Markdown.svelte`
  déclenche le chargement dès qu'une fence apparaît **pendant** le stream. Le
  test se fait dans `render()`, donc au rythme du debounce, pas à chaque token.
- Le chunk fait partie du shell préchargé par le service worker : après la
  première visite c'est un hit de cache, pas un aller-retour, et le hors-ligne
  reste entier. Un échec de chargement laisse le code en noir et blanc plutôt
  que de casser le message.

`tests/markdown.test.ts` rejoue un tour entier caractère par caractère et
compare, à chaque étape, `tête + queue` au rendu d'une seule passe sur tout le
tampon — c'est la seule propriété sur laquelle repose la coupure ; l'endroit où
elle tombe est un détail d'implémentation. Il vérifie aussi qu'aucun `import`
**statique** de `highlight.js` ne revient — ce serait remettre les 164 Ko sur le chemin
critique sans que rien ne le signale.

### 10. Hermes ne recharge pas `.env` à chaud

Après toute modification de `~/.hermes/.env` ou `config.yaml` :
`systemctl --user restart hermes-gateway`.

### 11. L'éditeur de skills touche des fichiers, pas l'API

`GET /v1/skills` (proxifié par `/api/skills`, et servi depuis le cache mémoire
du point 26) dit ce que Hermes **a chargé**. L'éditeur, lui, travaille sur le
disque : `SKILLS_DIR` (le bind mount `/skills`
en Docker, rien du tout ailleurs) pointe sur `~/.hermes/skills`, organisé en
`<catégorie>/<skill>/SKILL.md` avec un `DESCRIPTION.md` par catégorie.

Rien ici ne suppose que Hermes relit ses skills à chaud — l'UI dit simplement
qu'un `systemctl --user restart hermes-gateway` peut être nécessaire. Ne pas
prétendre le contraire sans l'avoir mesuré.

Les invariants, tous dans `src/lib/skills.ts` (pur, testé) et
`src/lib/server/skills.ts` (fs) :

- Chaque composant de chemin passe par `skillSegments()` : noms validés
  `^[a-z0-9][a-z0-9-]*$`, 64 caractères max. Ni `..`, ni `/`, ni fichier caché
  ne peuvent en sortir — `.bundled_manifest` et `.curator_state` appartiennent
  au tri automatique de Hermes et ne sont ni listés ni ouverts.
- Seuls `SKILL.md` (niveau skill) et `DESCRIPTION.md` (niveau catégorie) sont
  adressables, et chacun uniquement à son niveau.
- Le répertoire porteur est **realpath-é** et doit rester dans le realpath de
  la racine. C'est ce qui bloque un lien symbolique planté dans l'arbre
  (vérifié : un `escaped -> /tmp/…` répond `invalid_skill_path` en lecture
  comme en écriture). Les répertoires symlinkés ne sont pas non plus listés.
- 256 Ko max en lecture comme en écriture, et l'écriture est atomique
  (fichier temporaire **non caché** dans le même répertoire, puis `rename`).
- Pas de suppression, et pas de création par écrasement : un skill existant
  répond 409 `skill_exists`.
- `SKILLS_DIR` absent ou illisible → `available: false` sur
  `GET /api/skills/files`, et le panneau s'affiche désactivé. C'est le cas
  normal en `npm run dev` hors Docker : ne pas le traiter comme une erreur.
  L'inverse compte autant : un 429, une erreur disque ou une connexion perdue
  ne sont **pas** `available: false` et ne doivent jamais atteindre cet
  écran-là — voir le point 4 du contrat d'erreurs.

Routes : `GET|POST /api/skills/files` (liste / création) et
`GET|PUT /api/skills/files/content` (lecture / écriture). Elles n'utilisent pas
`proxy()` — il ne connaît que `HermesError` — mais `skillsJson()`, son
équivalent pour `SkillsFsError`.

### 12. Archiver, c'est une porte à sens unique côté API

`GET /api/sessions` ne peut **jamais** renvoyer une conversation archivée.
`_handle_list_sessions` appelle `list_sessions_rich()` sans `include_archived`
(défaut `False`) et n'expose aucun paramètre de requête pour le changer —
`archived_only` non plus. Vérifié : zéro occurrence des deux dans
`api_server.py` (0.20.0). Seul `GET /api/sessions/{id}` atteint une ligne
archivée, car `get_session` ne filtre pas.

Conséquence : filtrer la liste sur `archived` ne peut donner qu'un résultat
vide. La sidebar tient donc **deux** listes distinctes — `chat.sessions`
(vivantes, celles que l'amont renvoie) et `chat.archivedSessions` — et
`toggleArchive()` déplace la ligne de l'une à l'autre au lieu de basculer un
drapeau sur place.

Le contournement pour retrouver les archivées :

- `session_meta` (dans `data/hermes-web.db`, déjà là pour le cache de titres)
  sert d'**index des identifiants déjà vus**. `GET /api/sessions` y enregistre
  chaque id renvoyé (`rememberSessions()`, insertion seule : rafraîchir la
  sidebar ne doit pas réécrire 200 lignes).
- `GET /api/sessions?archived=true` prend les ids connus, retire ceux que la
  liste vivante renvoie encore (`archivedCandidates()`, pur et testé), et
  interroge chaque survivant par `GET /api/sessions/{id}`. Un 404 sort l'id de
  l'index (supprimée ailleurs) ; une ligne non archivée était simplement hors
  fenêtre de récence.
- Le fan-out est plafonné à 60 sondes, 6 en parallèle, et la réponse porte
  `truncated` pour que l'UI le dise au lieu de faire croire à un archivage
  exhaustif. C'est aussi pourquoi cette vue est chargée **à la demande** et
  jamais pendant un `refreshSessions()`.

Limite assumée : une conversation archivée **avant** que son id soit entré dans
l'index reste introuvable. Ça couvre l'archivage fait depuis l'UI, depuis le
CLI, ou par la purge `sessions.auto_archive` de Hermes, tant que la
conversation a été vue au moins une fois dans une liste.

### 13. Les providers passent par le dashboard, jamais par une écriture directe

`~/.hermes/.env` n'est pas la seule copie d'une clé d'API. `config.yaml` en
garde des miroirs dans `model.api_key`, `auxiliary.*.api_key` et
`custom_providers[*]`, et ces miroirs sont **prioritaires**. Écrire `.env`
nous-mêmes laisserait donc l'ancienne clé authentifier après une rotation.

`PUT /api/env` du dashboard passe par `save_provider_env_credential`, qui écrit
et réconcilie les deux. On proxifie, on ne recode pas. Idem pour la suppression
(`remove_provider_env_credential`, qui nettoie aussi `auth.json` et le cache de
modèles).

Ce qui a été vérifié sur cette machine, contre `hermes_cli/web_server.py` :

- **Toute route `/api/*` du dashboard exige le jeton**, y compris
  `GET /api/providers/oauth/{id}/poll/{sid}` : le handler n'appelle pas
  `_require_token`, mais `auth_middleware` gate tout ce qui n'est pas dans
  `PUBLIC_API_PATHS`. Mesuré : `401 {"detail":"Unauthorized"}` sans en-tête.
  Notre proxy envoie le jeton partout, donc ça ne change rien — mais ne pas
  écrire dans l'UI qu'une route serait publique.
- `GET /api/env` renvoie ~320 variables, dont 75 de `category == "provider"` et
  40 avec `is_password`. `groupProviderKeys()` ne garde que ces 40 et tourne
  **côté serveur** : les autres lignes (dont les secrets personnels rangés en
  `category == "custom"`) ne doivent pas atteindre la page, même caviardées.
- Les `*_BASE_URL` sont aussi des lignes `provider`, mais ce sont des réglages,
  pas des identifiants. Le panneau les exclut : un champ « clé » et un champ
  « URL » côte à côte, c'est une clé collée dans le mauvais champ.
- `POST /api/providers/validate` ne sonde que OPENROUTER / OPENAI / XAI /
  GEMINI. Partout ailleurs la réponse est `{ok: true, reachable: false}`, ce qui
  veut dire « inconnu », pas « mauvais » : seul un `{ok: false, reachable:
  true}` bloque l'enregistrement (`validationBlocks()`).
- `flow == "external"` (qwen-oauth, copilot-acp, claude-code) : `POST
  .../start` répond **400 avec la commande CLI à lancer**. Mesuré. Le panneau
  affiche la commande et ne propose pas de bouton — ne pas prétendre gérer ce
  flux.
- `flow == "pkce"` n'existe que pour `anthropic`, et le `submit` est réservé à
  lui. Les autres sont en `device_code` : code + URL de vérification, puis
  sondage jusqu'à `approved | denied | expired | error`.
- `POST /api/model/set` peut répondre `{ok: false, confirm_required: true,
  confirm_message}` **sans rien écrire** quand le garde-fou de coût s'inquiète.
  Le panneau affiche l'avertissement et rejoue avec
  `confirm_expensive_model: true`. Ce modèle global ne vaut que pour les
  **nouvelles** conversations — le changement à chaud reste le point 3.

Ce que l'UI ne fait délibérément pas :

- **`POST /api/env/reveal` n'est pas proxifié.** Le dashboard ne donne que
  `redacted_value` (`sk-o...60c6`) et c'est tout ce qui atteint le navigateur.
  Aucune valeur de clé n'est journalisée non plus.
- `HERMES_DASHBOARD_TOKEN` ne quitte jamais le serveur. Absent → le panneau
  s'affiche désactivé et le reste de l'application fonctionne, exactement comme
  l'éditeur de skills sans son bind mount.
- Les messages d'erreur du dashboard sont déjà en français quand ils viennent
  de `dashboard.ts` (jeton, injoignable, timeout) ; ceux qui viennent de
  FastAPI (`{"detail": ...}`) sont passés tels quels, parce que leur contenu
  *est* l'information utile (« run `hermes auth add qwen-oauth` manually »).
  D'où l'absence de cas supplémentaires dans `humanizeError()`.

Deux routes de lecture viennent du dashboard sans rapport avec les
providers : `GET /api/cron/delivery-targets`, qui dit quelles plateformes ont un
canal d'accueil configuré (point 14), et `GET /api/system/stats`, les
constantes vitales du Pi (point 35).

Le jeton vient de `HERMES_DASHBOARD_SESSION_TOKEN` dans
`~/.hermes/dashboard.env`, que l'unité systemd `hermes-dashboard.service` lit
via `EnvironmentFile` — il survit donc aux redémarrages du service.

Routes : `GET /api/providers` (clés groupées + comptes, en un aller-retour),
`PUT|DELETE /api/providers/keys`, `POST /api/providers/keys/validate`,
`POST|DELETE /api/providers/oauth/{id}`,
`GET /api/providers/oauth/{id}/poll/{sid}`,
`POST /api/providers/oauth/{id}/submit`,
`DELETE /api/providers/oauth/sessions/{sid}` et `POST /api/providers/model`.
Elles n'utilisent pas `proxy()` mais `dashboardResponse()`, son équivalent pour
`DashboardError`.

Limite assumée : ces routes écrivent dans la configuration de Hermes sans
authentification applicative. C'est le même modèle de menace que le reste de
l'application — quiconque atteint cette UI pilote déjà un agent qui a un
terminal sur le Pi — mais c'est à garder en tête si l'exposition change.

### 14. Les tâches planifiées : `/api/jobs`, avec trois pièges mesurés

Le gateway expose le cron de Hermes en entier — `GET|POST /api/jobs`,
`GET|PATCH|DELETE /api/jobs/{id}`, `POST /api/jobs/{id}/{pause|resume|run}` —
et l'UI en utilise la liste, la création, les trois actions et la suppression
(`ProvidersPanel` a son pendant : `JobsPanel`). Ce qui a été **mesuré** sur
cette machine, contre `api_server.py` et `cron/jobs.py` (0.20.0) :

- **Une tâche mise en pause disparaît de la liste par défaut.** `pause` retire
  `enabled`, et `_handle_list_jobs` appelle `_cron_list()` sans
  `include_disabled` (défaut `False`). Sans le paramètre, la ligne s'évanouit
  au clic sur « Mettre en pause ». `listJobs()` envoie donc toujours
  `?include_disabled=true` et l'UI affiche l'état elle-même.
- **Un horaire invalide répond 500, pas 400.** `_handle_create_job` ne valide
  que `name` et `prompt` ; `parse_schedule` lève un `ValueError` qui tombe dans
  l'`except Exception` générique. D'où `parseSchedule()` dans `src/lib/jobs.ts`
  (pur, testé), qui rejoue les règles amont côté navigateur *et* côté route :
  `every <durée>` d'abord, puis 5+ champs cron, puis un timestamp ISO, puis une
  durée nue. Les bornes des cinq champs cron sont vérifiées en plus, parce que
  `croniter` refuserait `0 25 * * *` en 500 aussi.
- **`schedule` est un objet, pas une chaîne** :
  `{kind, expr|minutes|run_at, display}`. L'afficher tel quel imprime
  `[object Object]` — c'est ce que faisait le `StatusPanel`. `schedule_display`
  est la version lisible, mais elle est en anglais et en minutes brutes
  (« every 720m ») : `scheduleDisplay()` repart des champs structurés et ne
  retombe dessus qu'en dernier recours. De même, `state` est l'état réconcilié
  par `effective_job_state()` (un job `enabled` n'est jamais affiché en pause) —
  il n'existe pas de champ `paused`.

La **livraison** ne se devine pas côté gateway : `deliver` est résolu au
déclenchement à partir des `*_HOME_CHANNEL` de l'environnement, que l'API ne
publie pas. La liste vient donc du dashboard,
`GET /api/cron/delivery-targets`, dont seul `home_target_set` distingue une
plateforme qui livrera vraiment d'une qui résoudrait vers rien
(`usableTargets()`). Le dashboard injoignable ne casse pas le panneau : il ne
reste que `local`, la seule promesse tenable sans cette information.

`deliver = "origin"` n'est **pas** proposé : une tâche créée par cette UI porte
un `origin` `{platform: "api_server", chat_id: "api"}`, qui n'est pas une
destination livrable.

Le gateway sans son module cron répond 501 `Cron module not available` : le
panneau le dit et se désactive, comme l'éditeur de skills sans son bind mount.
Ne pas se fier au drapeau `features.jobs_admin` de `/v1/capabilities` — il est
codé en dur à `false` alors que les routes fonctionnent.

**Une tâche appartient à un agent, et sa fiche voyage dans le prompt.** Le cron
de Hermes ne connaît qu'un prompt par tâche : `_handle_create_job` ne transmet
que `name`, `schedule`, `prompt`, `deliver`, `skills` et `repeat` — ni
`system_message`, ni `model`, alors que `cron/jobs.py::create_job` les accepte.
Faire tourner une tâche « en tant qu'agent » veut donc dire **composer sa fiche
dans le prompt**, ce que fait `composeJobPrompt()` (pur, testé) : la fiche
d'abord, un en-tête qui dit que personne ne regarde, puis l'instruction. Trois
conséquences :

- **L'instruction passe avant la fiche** quand les 5 000 caractères amont sont
  atteints : c'est la fiche qui est rognée, jamais la consigne.
  `jobInstructionLimit()` donne la borne à afficher, et le panneau montre le
  coût réel (« dont N pour la fiche de l'agent ») en rejouant la **même**
  fonction que le serveur.
- Le lien tâche → agent et l'instruction telle que tapée vivent dans
  `job_meta` (`data/hermes-web.db`), pas dans Hermes : une fois composé, le
  prompt amont ne se re-découpe pas. `GET /api/jobs` ajoute `agent_id`,
  `instruction` et `persona_stale` à chaque ligne, comme `agent_id` sur une
  session (point 18). Une tâche planifiée avant cette table n'a pas de ligne :
  son prompt **est** son instruction, et elle n'a pas d'agent.
- `persona_stale` est vrai quand la fiche de l'agent a été modifiée depuis :
  le serveur recompose et compare au prompt que Hermes détient. Le panneau
  propose alors « Mettre à jour » (un `PATCH` avec les mêmes valeurs), au lieu
  de laisser croire qu'éditer un agent met ses tâches à jour toutes seules.

Deux détails mesurés sur l'édition :

- `PATCH /api/jobs/{id}` accepte `schedule` en **chaîne** : `update_job` la
  re-parse et recalcule `next_run_at` lui-même. L'UI envoie donc toujours le
  formulaire entier — un corps sans aucun champ autorisé répond 400 de toute
  façon.
- Ré-envoyer l'horaire d'un **one-shot déjà passé** est refusé par `update_job`
  (`ValueError` → 500). `canEditJob()` le détecte côté client : la tâche
  s'édite quand même, mais il faut choisir une nouvelle date, et le bouton
  « Mettre à jour la fiche » disparaît.

Côté ergonomie, l'horaire ne se tape plus : `scheduleFromSpec()` /
`specFromExpression()` traduisent dans les deux sens entre les sélecteurs
(chaque jour / semaine / mois, intervalle, une fois) et l'expression amont, et
`humanCron()` affiche « chaque vendredi à 19 h 00 » plutôt que `0 19 * * 5`. Ce
qui ne rentre pas dans ces cas (`0 9-18 * * 1-5`) reste en mode « Expression »
et fait l'aller-retour intact.

Routes : `GET|POST /api/jobs` (liste + cibles de livraison en un aller-retour /
création) et `POST|PATCH|DELETE /api/jobs/{id}` (action / édition /
suppression).

### 15. Les prompts enregistrés sont de l'état d'UI, pas de l'état Hermes

Hermes n'a aucun endpoint de bibliothèque de prompts — ni dans
`api_server.py`, ni dans le dashboard. Les prompts enregistrés vivent donc dans
la table `prefs` de `data/hermes-web.db`, sous la clé `saved_prompts`, derrière
`GET|PUT /api/prompts`. Ne pas chercher à les faire porter par une session ni
par la mémoire long-terme de Hermes : ce sont des raccourcis d'interface.

Le stockage est **serveur** et non `localStorage`, et c'est tout l'intérêt : un
prompt enregistré depuis le desktop est là sur le téléphone. Deux conséquences
dans le code :

- La ligne prefs est un seul blob JSON, donc les bornes sont appliquées
  **côté serveur** par `normalizePrompts()` (`src/lib/prompts.ts`, pur et
  testé) : 40 prompts, 4 000 caractères par prompt, 60 pour le titre. La même
  fonction sert de garde-fou au navigateur et de réparateur d'une ligne écrite
  par une version antérieure — elle ne jette jamais.
- `PUT /api/prompts` **refuse** un corps dont `prompts` n'est pas une liste
  (400 `invalid_body`) au lieu de le normaliser en `[]` : un bug côté client ne
  doit pas pouvoir effacer la bibliothèque. L'écriture est un remplacement
  complet, et le store adopte la réponse du serveur — c'est la version bornée.
- **Ce remplacement complet est ce qui rend « pas encore lue » et « vide » deux
  états distincts**, et les confondre efface tout. Mesuré : GET initial en
  échec → `items` reste `[]`, le panneau affiche « Chargement… »
  indéfiniment, et le premier enregistrement remplace les **trois** prompts
  stockés par un seul, sous un toast vert « Prompt enregistré. » D'où
  `PromptBaseline = SavedPrompt[] | null` : `addPrompt()` et `removePrompt()`
  prennent une base **nullable** et rendent `{ok: false, reason: 'unloaded'}`
  sur `null`, si bien que l'appel dangereux ne s'écrit plus. Le store expose
  `baseline` (`loaded ? items : null`), et **les deux écritures rejouent
  `ensureLoaded()` avant de composer** : une panne passagère se répare donc
  toute seule au moment de l'enregistrement, et seule une bibliothèque toujours
  illisible refuse — avec `loadError` affiché et un bouton « Réessayer », plus
  jamais un « Chargement… » éternel.
- Un compteur d'écritures (`#writes`) empêche un GET lent d'écraser une
  écriture plus récente : la réponse n'est adoptée que si aucune écriture n'a
  abouti entre-temps. Sans ça, ouvrir la palette puis enregistrer aussitôt
  faisait réapparaître l'ancienne liste à l'écran — et la livrait au
  remplacement suivant.

Côté UI, un prompt choisi est **ajouté** au composeur, jamais substitué : un
message à moitié écrit doit survivre à un tap malheureux sur la bibliothèque.

### 16. Le serveur possède le tour, pas le navigateur

C'est le renversement qui rend les notifications possibles. Avant, le relais SSE
annulait le `fetch` amont dès que le navigateur partait : le serveur n'apprenait
jamais comment le tour s'était terminé. Or on savait déjà (point 2) que
**l'agent, lui, continue** — annuler ne servait donc à rien et coûtait la seule
chose utile : la réponse, au moment où elle arrive, pendant que l'utilisateur
est ailleurs.

`src/lib/server/turns.ts` tient donc un registre des tours en vol. La route
`/api/sessions/{id}/stream` démarre le tour, `beginTurn()` lit le flux amont
**jusqu'à son événement terminal quoi qu'il arrive** et le recopie vers le
navigateur tant qu'il est attaché. Ce qui change concrètement :

- Le signal d'abandon du navigateur n'est **plus** câblé sur le `fetch` amont.
  Fermer l'onglet ou taper le bouton carré détache l'affichage, exactement comme
  avant côté UI, mais la boucle de lecture continue.
- Le créneau du sémaphore `MAX_CONCURRENT_TURNS` est tenu pour **toute** la
  durée du tour, plus seulement pendant que quelqu'un regarde. C'est plus juste
  (le Pi travaille vraiment) mais se détacher puis renvoyer aussitôt peut
  atteindre le plafond.
- Plus rien ne libérerait un tour amont bloqué, d'où `MAX_TURN_MS` (20 min par
  défaut) qui abandonne la lecture et rend le créneau.
- Le flux poussé vers le navigateur utilise une `ByteLengthQueuingStrategy` : un
  client qui ne lit plus (téléphone endormi, socket morte) est lâché au-delà
  d'un mégaoctet en attente au lieu de faire gonfler la mémoire du Pi.
- Aucun événement terminal n'est fabriqué à la fermeture : un flux qui s'arrête
  sans `done` reste ce que le client lit déjà comme « tronqué » (point du
  contrat d'erreurs), avec son bouton « Recharger ».

Un tour lancé sans en-tête `Origin` n'est **pas** notifiable : les navigateurs
en envoient un sur tout POST (c'est l'invariant sur lequel repose déjà
`hooks.server.ts`), donc son absence signifie un script — `scripts/smoke.sh`
joue un vrai tour après chaque déploiement et personne ne veut ça sur son écran
verrouillé à 5 h du matin.

### 17. Notifications push : ce qui est mesuré, ce qui ne l'est pas

Quand un tour se termine et que personne ne regardait, le serveur envoie une
notification Web Push. `shouldNotifyTurn()` (`src/lib/turns.ts`, pur et testé)
combine deux signaux, et **l'un des deux suffit** :

- **Aucun lecteur attaché** au flux SSE. iOS suspend une PWA en arrière-plan et
  la connexion tombe : ce signal seul couvre le téléphone.
- **`document.visibilityState`**, remonté par la page sur
  `POST /api/push/presence` (`visibilitychange` et `pagehide`, en `keepalive`).
  Sans lui, un onglet de bureau en arrière-plan garde son flux ouvert et
  ressemblerait à quelqu'un qui lit. La présence est **globale** au serveur —
  application mono-utilisateur — et ignorée passé 10 minutes.

Le chiffrement est écrit avec `node:crypto` (`src/lib/server/push-crypto.ts`),
sans dépendance : ECDH P-256, HKDF-SHA256, AES-128-GCM, et un JWT ES256 signé
avec `dsaEncoding: 'ieee-p1363'` — c'est ce qui évite la conversion DER → JOSE à
la main. `tests/push-crypto.test.ts` le confronte au **vecteur de test de la
RFC 8291 §5** : secret ECDH, PRK, CEK, nonce, en-tête de 86 octets et
chiffré, valeur par valeur. Ne pas modifier ce module sans que ce test passe.

Les contraintes iOS, à respecter sous peine de silence :

- La permission se demande depuis un **geste utilisateur**. `push.enable()`
  appelle `Notification.requestPermission()` en première instruction, avant tout
  `await` : Safari n'honore la demande que tant que le geste est sur la pile.
- Web Push n'existe que pour une PWA **installée sur l'écran d'accueil**. En
  onglet Safari, `subscribe` lève. `needsHomeScreenInstall()` détecte le cas et
  le panneau explique l'étape au lieu d'afficher un bouton condamné.
- **Chaque push affiche une notification.** Le handler `push` du service worker
  se termine toujours par `showNotification`, même sur charge utile absente ou
  illisible : Safari révoque l'abonnement d'un push silencieux.
- `410` et `404` du service de push suppriment la ligne ;
  `pushsubscriptionchange` se réabonne depuis le service worker (la clé publique
  revient de `GET /api/push`).

Ce qui a été vérifié sur cette machine, contre l'application construite et un
faux service de push qui déchiffre ce qu'il reçoit : client coupé à 1 s → tour
terminé côté serveur puis notification livrée et déchiffrée avec le bon titre de
conversation et le lien `/?s=<id>` ; client resté jusqu'au bout → aucune
notification ; client attaché mais présence « caché » → notification ; abonnement
malformé → ligne supprimée ; endpoint injoignable → `last_error` enregistré.
**Ce qui n'est pas vérifié** : la livraison réelle sur un iPhone. Elle dépend
d'APNs et de l'installation sur l'écran d'accueil — c'est le bouton « Envoyer un
test » du panneau d'état qui le dira.

Stockage : table `push_subscriptions` de `data/hermes-web.db`, une ligne par
appareil. L'endpoint est une **capacité** (le connaître suffit pour pousser vers
l'appareil) et ne sort donc jamais du serveur : l'UI ne voit qu'un condensé
(`deviceId`) et l'hôte du service de push.

**Hors périmètre, ne pas le laisser croire** : les réponses produites par les
tâches planifiées (`/api/jobs`) ou par Telegram ne passent pas par ce flux et ne
déclencheront aucune notification. Un tour dont le flux est tronqué, ou coupé
par `MAX_TURN_MS`, n'en déclenche pas non plus : on ne sait pas ce que Hermes a
répondu, et « quelque chose est peut-être prêt » vaut moins que le silence — la
réponse est de toute façon dans le transcript.

Routes : `GET|POST|DELETE /api/push` (configuration + liste / abonnement /
retrait), `POST /api/push/test`, `POST /api/push/presence`.

### 18. Les agents personnalisés : le prompt part à CHAQUE tour

Une conversation appartient à un **agent** — un nom, un emoji, un métier, un
prompt système, un modèle préféré facultatif, et la liste des agents qu'il a le
droit de piloter. Tout vit dans `data/hermes-web.db` (table `agents`, plus une
colonne `agent_id` ajoutée à `session_meta`) : Hermes n'a aucune notion de
persona, et lui en ajouter une voudrait dire le patcher.

Le point qui commande tout le reste, **vérifié** dans `api_server.py` (0.20.0) :

- `_handle_session_chat_stream` (~ligne 3782) construit son prompt système
  **uniquement** depuis `body.get("system_message") or body.get("instructions")`.
  La colonne `sessions.system_prompt`, elle, n'est jamais relue pour un tour :
  elle ne sert qu'à `has_system_prompt` et à la propagation lors d'un fork.
- `POST /api/sessions/{id}/model` met même cette colonne à NULL.

**Conséquence** : la persona doit être renvoyée dans `system_message` à chaque
message, sinon elle disparaît au deuxième tour — et un changement de modèle
l'effacerait pour de bon. C'est `/api/sessions/{id}/stream` qui la recompose,
via `systemPromptForSession()`, et **le navigateur n'a pas voix au chapitre** :
la route ignore délibérément tout `system_message` reçu dans le corps. Deux
onglets ne peuvent donc pas être en désaccord sur qui parle.

La hiérarchie n'est pas réimplémentée : c'est celle de Hermes. L'outil
`delegate_task` (toolset `delegation`, `tools/delegate_tool.py`) prend `goal`,
`context`, `tasks[]`, `output_schema` et surtout `role: "leaf" | "orchestrator"`
— un enfant `orchestrator` garde le toolset de délégation et peut spawner à son
tour, dans les bornes de `delegation.max_spawn_depth` /
`max_concurrent_children` de `~/.hermes/config.yaml`. Ne pas construire un
système de sous-agents par-dessus.

Ce que ça implique dans le code :

- `composeSystemPrompt()` (`src/lib/agents.ts`, pur et testé) écrit la section
  « Ton équipe » **à partir des fiches des agents enfants**, pas d'un texte
  saisi à la main : modifier le métier d'un spécialiste change ce que son chef
  sait de lui, sans rien réécrire. C'est ça, « facilement personnalisable ».
- Un enfant délégué démarre d'une conversation vide. Sa persona ne peut donc
  arriver que par le texte de l'appel — d'où la consigne, dans le prompt du
  chef, de recopier la fiche du spécialiste dans `context`. La fiche est bornée
  à `CHILD_BRIEF_CHARS` (800) : ce prompt repart à chaque message.
- Les seuls enfants annoncés comme `role: "orchestrator"` sont ceux qui sont
  eux-mêmes marqués orchestrateurs **et** ont une équipe. Un enfant `leaf` se
  voit retirer `delegate_task` par `DELEGATE_BLOCKED_TOOLS` : lui promettre une
  équipe serait un mensonge. `teamTree()` applique la même règle à l'affichage.
- Aucun chiffre de `config.yaml` n'est cité dans le prompt composé
  (profondeur, enfants simultanés) : aucun endpoint ne les publie, et un chiffre
  périmé dans un prompt système est pire que pas de chiffre. Le prompt dit
  seulement quoi faire si Hermes refuse l'appel.
- Une boucle dans l'équipe serait un prompt qui récurse à l'infini. Deux
  garde-fous, pas un : `validateAgent()` refuse le cycle à l'entrée en affichant
  la chaîne fautive (`Chef → Recherche → Chef`), et `normalizeAgents()` **casse**
  les arêtes fautives à la lecture, pour qu'une ligne écrite à la main ne puisse
  pas figer le serveur. `composeSystemPrompt()` et `teamTree()` sont bornés par
  ailleurs.
- Supprimer un agent le retire des équipes qui le citaient et délie ses
  conversations (`removeAgent`, transaction) ; leur transcript est intact, elles
  repassent simplement au prompt par défaut de Hermes.
- Le modèle préféré d'un agent l'emporte sur le sélecteur à la création d'une
  conversation, **mais seulement s'il est routable** : un id de modèle périmé sur
  une ligne de session fait échouer chaque tour (point 1).
- Le fork reprend l'agent du parent : c'est la même conversation continuée.
- `agent_id` sur une ligne de session **n'est pas un champ Hermes**. C'est le
  proxy `/api/sessions*` qui l'ajoute à la sortie, à partir de `session_meta`.

**Ce qui n'est PAS fait, et ne doit pas être promis** : les sous-agents ne sont
pas streamés. Sur la Sessions API une délégation n'apparaît que comme une étape
d'outil `delegate_task` ; les événements `subagent.start` / `subagent.complete`
/ `subagent.text` n'existent que sur le flux de la Runs API, écartée au point 2.
Hermes écrit bien un journal par sous-tâche dans
`<hermes_home>/cache/delegation/live/<delegation_id>/task-<n>.log`
(`tools/delegation_live_log.py`), mais ce répertoire n'est pas monté dans le
conteneur : soit on le monte en lecture seule et on le lit vraiment, soit on ne
promet rien. Pas d'entre-deux.

Routes : `GET|POST /api/agents`, `PATCH|DELETE /api/agents/{id}` et
`POST /api/sessions/{id}/agent` (relier une conversation ouverte à un agent, ou
`null` pour la détacher — effectif au message suivant, comme le verrou de
modèle du point 3).

Une **tâche planifiée** peut elle aussi porter un agent, mais par un tout autre
chemin : le cron n'accepte pas de `system_message`, donc la fiche est composée
**dans le prompt de la tâche** au moment où elle est enregistrée, et ne se met
pas à jour toute seule quand l'agent change. Voir le point 14.

### 19. Le thème : dix couleurs déclarées, tout le reste dérivé

L'apparence est un réglage à part entière, pas une bascule clair/sombre. Un
**préréglage** (`PRESETS` dans `src/lib/theme.ts`) déclare **dix couleurs par
mode** et rien de plus : fond, surface, surface creusée, texte, texte
secondaire, deux accents, tonalité profonde (`rail`), danger, succès. Survols,
bordures, texte discret, fonds doux et bulle de l'assistant sont **calculés**
par `themeVariables()` en `color-mix(in oklab, …)`. C'est ce qui fait qu'un
accent choisi ne peut pas laisser un survol périmé derrière lui : la couleur
n'est écrite qu'à un seul endroit.

Trois choses ne sont **pas** laissées au CSS, parce qu'elles demandent un calcul
qu'aucune feuille de style ne sait faire, et sont donc des fonctions pures
testées :

- `readableInk()` choisit, entre une encre sombre et le blanc, celle qui a le
  meilleur contraste WCAG sur une couleur. C'est ce qui pose le texte des
  badges, du bouton d'envoi et du rail.
- `ensureContrast()` **assombrit un accent juste assez** pour que le blanc
  dessus atteigne 4,5:1, et pas plus. C'est la bulle utilisateur : « orange
  plein, texte blanc » reste vrai même si l'utilisateur choisit un jaune. Le
  test rejoue tous les accents des préréglages plus les cas pathologiques
  (`#ffff00`, `#ffffff`, `#7f7f7f`).
- `ensureVisible()` pousse l'accent vers l'encre jusqu'à ce qu'il tienne 3:1 sur
  **tous** les fonds où il sera dessiné. C'est `--focus`, l'anneau de focus
  clavier — voir le point 22.

Points de détail qui comptent :

- **Le stockage est serveur** (`prefs`, clé `theme`, `GET|PUT /api/theme`),
  pour la même raison que les prompts enregistrés (point 15) : une palette
  choisie sur le bureau doit être celle qu'ouvre le téléphone. `normalizeTheme()`
  est la seule validation — préréglage inconnu, mode inconnu, accent qui n'est
  pas un `#rrggbb` : tout retombe sur le défaut, donc rien d'arbitraire ne peut
  atteindre `style.setProperty()`.
- **Le navigateur garde une copie**, dont des **variables calculées** : le
  script inline d'`app.html` rejoue une table clé → valeur et ne porte aucune
  logique. Il n'existe donc pas de seconde copie des règles de dérivation à
  tenir à jour. Sans ce cache, chaque ouverture de la PWA flashe la palette par
  défaut avant l'hydratation. Les réglages voyagent avec, mais **seulement pour
  l'affichage** : ils disent ce que cet appareil a peint en dernier, pas ce que
  le serveur détient.
- **`PUT /api/theme` remplace la ligne**, donc composer un changement sur un
  thème qu'on n'a pas su lire ne « retombe pas sur les défauts » : ça les
  **écrit** par-dessus la palette choisie. C'est la même leçon que la
  bibliothèque de prompts (point 15), et le même remède : `ThemeBaseline =
  ThemeSettings | null`, `planThemeUpdate()` qui rend `{ok: false, reason:
  'unloaded'}` sur `null`, et un `store.baseline` qui vaut `null` tant que le
  GET n'a pas répondu. **Mesuré** avant le garde-fou, en rejouant le vrai store
  contre un navigateur simulé — serveur sur Nocturne / clair / accent
  `#00b3a4`, GET initial en échec : `init()` repeignait les défauts, écrasait
  le cache localStorage avec eux, et un clic sur « Sombre » envoyait
  `{preset:"terracotta",mode:"dark",accent:null,accent2:null}`. La palette
  disparaissait des deux côtés, sans un mot.
- Deux conséquences côté UI : `init()` ne peint plus les défauts avant d'avoir
  lu quoi que ce soit (le script inline a déjà posé la bonne palette — c'était
  aussi un flash à chaque lancement, mesuré `#ee7c2b` puis `#00b3a4`), et le
  panneau Apparence affiche `loadError` avec un bouton « Réessayer » et
  désactive ses contrôles au lieu de laisser croire que « Terracotta » est le
  choix de l'utilisateur. Chaque écriture rejoue `ensureLoaded()` d'abord :
  une panne passagère se répare donc au moment du clic, et seule une ligne
  toujours illisible refuse.
- `src/app.css` déclare les mêmes noms avec des littéraux : c'est le rendu
  d'avant hydratation, et seulement ça. Un token déclaré là mais absent de
  `themeVariables()` garderait sa couleur d'usine au changement de
  préréglage — `tests/theme.test.ts` **lit la feuille de style** pour qu'aucun
  ne passe entre les mailles. Les formes (`--radius-*`, `--gap-panel`,
  `--rail-width`) sont exclues : ce sont le design, pas une préférence.
- Le rail sombre du design n'a de sens qu'en mode clair. En sombre, `p.rail`
  serait une colonne presque noire sur une page presque noire : `--rail` y est
  au contraire **relevé au-dessus de la surface**. `p.rail` reste dans les deux
  cas la tonalité vers laquelle on assombrit.
- **`color-mix` est requis** (Safari 16.2+, Chrome 111+). Tout appareil capable
  des notifications push de cette app (iOS 16.4+) en dispose ; ne pas le
  supposer ailleurs sans vérifier.

**Les douze palettes d'affiche.** Aux quatre préréglages d'origine s'ajoutent
douze relevés d'une étude d'affiches, **échantillonnés au pixel** et non à
l'œil : Corail, Crème, Pinède, Lagune, Brume, Abricot, Framboise, Menthe,
Ambre, Dragée, Brique, Outremer. Une affiche, ce sont deux couleurs — un fond
plat et le mot imprimé dessus —, c'est-à-dire exactement la paire
`accent` / `accent2` ; celle des deux qui se lit comme un rehaut mène, donc une
affiche à fond sombre (Pinède, Outremer) donne la main à son lettrage.

Les huit autres couleurs, elles, **ne viennent pas des affiches** : un aplat
saturé plein cadre, c'est une affiche, pas une page qu'on lit une heure. Ce
sont des neutres teintés vers la couleur de l'affiche — la teinte passe dans
les surfaces sans jamais colorer le texte. Ajouter une palette veut dire écrire
ces dix littéraux et laisser `tests/theme.test.ts` juger : texte à 4,5:1 sur sa
propre surface, texte discret à 3:1, et un anneau de focus qui tient 3:1 sur
les trois fonds **quel que soit** l'accent tapé ensuite. Aucune de ces
vérifications n'est facultative, et aucune n'a eu besoin d'être assouplie pour
que les douze passent.

### 20. iPhone : le clavier ne redimensionne pas le viewport en PWA installée

`interactive-widget=resizes-visual` est **ignoré** en mode standalone. Dans
l'app installée sur l'écran d'accueil, le viewport de mise en page garde toute
sa hauteur et le clavier recouvre simplement le bas de la page — composeur
compris. La seule mesure fiable est l'**API `visualViewport`** :
`window.innerHeight - visualViewport.height - visualViewport.offsetTop`, écouté
sur `resize` **et** `scroll`, publié par `+page.svelte` en variable CSS
`--keyboard` sur `.app`. Les petits écarts (< 24 px) sont de la barre d'outils
Safari, pas un clavier, et sont ignorés.

Le reste des contraintes tactiles : `viewport-fit=cover` est déjà dans
`app.html` (sans lui `env(safe-area-inset-*)` renvoie 0), l'encoche est gérée
par le `padding-top` de l'entête, la barre d'accueil par le composeur, les
cibles font 44 px, et `-webkit-tap-highlight-color: transparent` retire le
carré gris d'iOS.

Sur téléphone, la refonte en panneaux flottants est **délibérément
désactivée** : des cartes à 14 px de marge sur 390 px de large, c'est de la
place perdue. En dessous de 820 px, `.app` reprend ses gouttières, `main`
perd son rayon, et les panneaux modaux deviennent des **feuilles qui montent du
bas**, arrondies en haut seulement.

Cette feuille n'est écrite qu'**une fois**, dans `Modal.svelte` : voir le
point 21.

**Et la sidebar, sous 820 px, n'est pas une colonne mais un tiroir** : elle
quitte le flux, se pose en `position: fixed`, glisse par-dessus le fil derrière
un voile. C'est un dialogue modal, avec tout ce que ça implique — voir le
point 22.

### 21. Un seul cadre pour tous les panneaux modaux

`Modal.svelte` porte le voile, la carte centrée, la barre de titre (titre,
sous-titre facultatif, bouton ✕), le pied de page facultatif et la feuille
téléphone du point 20. Les panneaux — État, Skills, Providers, Tâches, Agents,
Apparence, Approbations, Consommation, Raccourcis — ne fournissent que leur
contenu :

```svelte
<Modal {open} title="Tâches planifiées" width={620} {onclose}>
	{#snippet subtitle()}Hermes les exécute seul, même app fermée{/snippet}
	<div class="body">…</div>
	{#snippet footer()}…{/snippet}
</Modal>
```

Ce qui reste au panneau, et pourquoi :

- **Échap**, parce que sa signification diffère : sortir d'un formulaire
  d'édition (Tâches, Agents), refuser de fermer sur des modifications non
  enregistrées (`tryClose` de Skills), ou simplement fermer. Le cadre ne
  connaît que `onclose`, que le panneau branche sur ce qu'il veut.
- Le **corps** : padding, colonnes, défilement. Le cadre est un `flex column`,
  rien de plus.
- Les seuls réglages exposés sont `width` (en px, la carte se rétrécit toute
  seule sur une fenêtre étroite) et `fill` (occuper toute la hauteur, pour les
  panneaux à éditeur plutôt que ceux qui épousent leur contenu).

**Le contenu d'un snippet reste stylé par le panneau, pas par le cadre.** Un
sélecteur écrit dans `Modal.svelte` ne porte que sur les éléments écrits dans
`Modal.svelte` — c'est le scoping de Svelte. Un `footer .muted` côté panneau ne
s'appliquerait donc plus : ces contenus se stylent par leur propre classe.

`tests/panels.test.ts` échoue si un panneau redéclare le cadre ou reprend son
propre `role="dialog"`. Les sept copies avaient déjà divergé (84 vs 86 vs 88vh,
cible de fermeture à 44 px sur un seul, `env(safe-area-inset-bottom)` oublié
là où le pied de page le posait déjà) : c'est ce que fait un bloc copié.

**Et aucun de ces panneaux n'est chargé au démarrage.** Ils ne sont pas à
l'écran quand l'app s'ouvre, mais importés statiquement ils formaient la plus
grosse part de ce que le Pi devait télécharger, analyser et compiler avant de
peindre le premier message. `lazyComponent()` (`src/lib/client/lazy.svelte.ts`)
les récupère à la première ouverture, et `+page.svelte` ne les rend qu'une fois le
chunk arrivé.

**Mesuré sur l'application construite**, en additionnant le JS réellement
atteignable depuis l'entrée et les nœuds de la page :

| | JS critique (brut) | JS critique (brotli) | CSS du démarrage |
|---|---|---|---|
| Avant | 313 296 o | 97 060 o | 57 745 o |
| Après | 227 928 o | 74 879 o | 29 872 o |

Soit −27 % de JS à analyser et −48 % de CSS sur le chemin critique. Mesuré au
CDP sur ce Pi, sur cinq chargements sans cache : le temps d'exécution JS par
chargement passe d'environ 10 ms à 8,5 ms, et 22 ko de moins passent sur le
fil. Le gain n'est pas spectaculaire en millisecondes — il l'est en octets, et
c'est ce qui compte sur un lien lent.

Trois choses qui rendent ça sûr, et qu'il ne faut pas défaire :

- Chaque panneau gate déjà ses appels par `$effect(() => { if (open) … })`. Les
  monter tard ne change donc *rien* à ce qu'ils font — seulement au moment où
  leur code arrive.
- Une fois chargé, le panneau **reste** dans l'arbre : la réouverture est aussi
  immédiate qu'avant. Vérifié au CDP, ainsi que le contrat du point 22 — à la
  toute première ouverture le focus atterrit bien sur `[role=dialog]`, et Échap
  le rend au bouton d'origine.
- Les chunks (JS **et** CSS, injecté par le helper de préchargement de Vite)
  font partie du shell préchargé par le service worker : après la première
  visite, ouvrir un panneau est un hit de cache, pas un aller-retour. C'est le
  même marché que la coloration syntaxique au point 9.

Un échec de chargement affiche un toast et se réessaie à l'ouverture suivante,
plutôt que de laisser un bouton mort. `tests/panels.test.ts` échoue si un
`import` statique d'un panneau revient dans `+page.svelte`, ou si un panneau est
rendu sans son garde `panels.<clé>.current`.

`CommandPalette` reste, lui, importé statiquement : c'est un contrôle au
clavier où la latence se sent, et ses dépendances (`chat`, `$lib/sessions`) sont
déjà sur le chemin critique — le split n'y gagnerait presque rien.

### 22. Le focus appartient au cadre, et l'anneau est une couleur du thème

Deux choses qu'aucun panneau ne faisait, et qui tiennent maintenant en un seul
endroit chacune.

**Le cadre possède le focus.** `Modal.svelte` déplace le focus sur la carte à
l'ouverture, empêche Tab d'en sortir, et le rend à ce qui a ouvert le panneau à
la fermeture. Trois choix, dans cet ordre d'importance :

- Le focus va sur la **carte** (`tabindex="-1"`), pas sur le premier bouton :
  un lecteur d'écran annonce alors le dialogue et son nom avant tout le reste,
  et aucun champ ne vole le curseur — ce qui, sur iPhone, ferait monter le
  clavier pour un panneau qu'on voulait seulement lire. `.panel:focus` n'a donc
  pas d'anneau : l'annonce est le signal.
- Le piège n'agit **qu'aux extrémités** : `trapIndex()` (`src/lib/a11y.ts`,
  pur et testé) ne renvoie un indice que si la tabulation allait sortir. Ailleurs
  le navigateur fait son travail, ce qui laisse intactes la sélection de texte
  et la saisie dans un champ.
- Les arrêts sont filtrés sur `getClientRects().length > 0` — un formulaire
  replié ne doit pas capturer le focus. `offsetParent` ne conviendrait pas :
  la carte est en `position: fixed`.

Mesuré sur l'application construite, pilotée en CDP : à l'ouverture du panneau
Raccourcis le focus est bien sur `[role=dialog]` ; Tab tourne sur le seul arrêt
(✕) sans jamais sortir ; Échap ferme et rend le focus au bouton « Raccourcis ».
Sur le panneau Apparence (10 arrêts), Tab revient au premier après le dernier et
⇧Tab passe du premier au dernier, sans fuite.

**L'anneau de focus est un token.** `--focus` sort de `ensureVisible()`
(`src/lib/theme.ts`) : l'accent, poussé vers l'encre juste assez pour tenir 3:1
(WCAG 1.4.11) sur les **trois** fonds où il peut être dessiné — la page, un
panneau, un champ creusé. Sans ça, l'indigo de « Nocturne » ou n'importe quelle
couleur sombre saisie dans le champ d'accent donnerait un anneau invisible.
`tests/theme.test.ts` rejoue **tous** les préréglages × deux modes × les accents
pathologiques — c'est ce qui rend l'ajout d'une palette sûr : une palette qui
ne tiendrait pas le contrat ne passe pas les tests.

**Le tiroir mobile est ce même dialogue.** Sous 820 px la sidebar sort du
flux et recouvre le fil : elle est donc modale, et `Modal.svelte` et
`Sidebar.svelte` partagent maintenant `src/lib/client/dialog.svelte.ts`
(`dialogFocus`, `trapTab`) plutôt que d'en tenir chacun une copie. Ce qui a été
**mesuré** au CDP sur l'application construite, en 414 × 896 :

- **Fermé, un tiroir n'est pas hors de portée.** Garé en
  `translateX(-100%)`, il reste dans l'ordre de tabulation et dans l'arbre
  d'accessibilité : mesuré, 4 arrêts de tabulation atteints en 25 Tab depuis le
  haut du document — et bien plus dès qu'il y a des conversations, chacune
  ajoutant deux boutons. D'où `inert={drawer && !open}`, qui ramène ce compte à
  **0** sans rien changer à l'animation. En 1280 px de large, `inert` reste
  faux : la colonne est du contenu ordinaire.
- **Ouvert, il s'annonce** : `role="dialog"`, `aria-modal`, `aria-label`
  « Discussions », posés **seulement** quand `drawer && open` — un
  `role="dialog"` permanent sur la colonne de bureau serait un mensonge. Le
  focus va sur l'`<aside>` lui-même (même raison qu'au-dessus : l'annonce plutôt
  qu'un anneau autour de 300 px de panneau, d'où le `.sidebar:focus { outline:
  none }` que compte `tests/a11y.test.ts`).
- **Tab n'en sort pas** (mesuré : 30 Tab et 8 ⇧Tab, zéro fuite), et **Échap le
  ferme** en rendant le focus au bouton ☰ — vérifié en ouvrant le tiroir au
  clavier. Le piège est branché sur `<svelte:window>` et non sur l'`<aside>` :
  en colonne, la sidebar ne doit rien retenir du tout.
- Redimensionner la fenêtre au-delà de 820 px pendant que le tiroir est ouvert
  le **ferme** : il cesse d'être un tiroir, un voile resterait sur la page et
  Échap ne voudrait plus dire « ferme-moi ».
- **Un seul piège à la fois.** Un panneau ouvert depuis le pied du tiroir se
  poserait sur un dialogue qui retient déjà Tab, et deux pièges qui tirent en
  sens inverse valent moins qu'aucun : le tiroir arracherait le focus du
  panneau où l'utilisateur se trouve. Deux verrous — le tiroir n'agit que sur
  un Tab pressé **à l'intérieur de lui-même**, et `openFromSidebar()` referme
  le tiroir en ouvrant le panneau. Mesuré : tiroir ouvert au clavier → « 📚
  Skills » → tiroir fermé et `inert`, focus dans le panneau, 12 Tab sans une
  seule fuite.

Deux détails tactiles du même ordre, dans le tiroir :

- Le menu « ⋯ » d'une ligne (renommer, épingler, brancher, archiver,
  supprimer) était révélé par le survol — qu'un doigt n'a pas, et qu'une
  tabulation n'a pas non plus : c'était cinq actions inatteignables au
  téléphone sur toute ligne sauf la ligne active, et un arrêt de tabulation en
  `opacity: 0` sur le bureau. Il n'est masqué que sous `@media (hover: hover)
  and (min-width: 821px)`, et même là `.row:focus-within` le rend visible.
- Les lignes, le champ de recherche et les boutons du pied passent à 44 px sous
  820 px, comme tout le reste de l'app tactile.

La règle globale est dans `app.css`, en `:focus-visible` (jamais `:focus` : un
clic à la souris ne doit rien dessiner). Comme presque tout ici est un bouton nu
ou un champ sans bordure, un `outline: none` posé dans un composant supprime la
seule indication de position qui reste — douze le faisaient. `tests/a11y.test.ts`
compte les `outline: none` restants et n'en tolère que trois, chacun justifié :
le composeur (c'est la boîte qui s'allume, `:focus-within`), l'éditeur de skills
(le curseur fait office d'indicateur sur une surface pleine page) et la carte
modale ci-dessus.

**Et un menu surgissant est le troisième dialogue de l'app.** Trois surfaces
ouvrent un panneau flottant depuis un bouton : le sélecteur de modèle, celui
d'agent et le « ⋯ » d'une ligne de sidebar. Toutes trois étaient purement
pointeur. Le problème n'était pas seulement ce qui manquait, mais ce que
l'absence provoquait : **Échap traversait le menu jusqu'à `+page.svelte`**, où
un Échap nu veut dire « ferme le tiroir » ou, pendant qu'un tour s'écrit,
`chat.stop()`. Refermer une liste de modèles détachait donc la réponse en
cours.

Le contrat commun vit dans `src/lib/client/menu.svelte.ts` (`menuStops`,
`menuKeydown`) et son arithmétique dans `menuIndex()` (`src/lib/a11y.ts`, pur et
testé), exactement comme `dialog.svelte.ts` / `trapIndex()` au-dessus :

- **Échap est arrêté dans le helper**, pas dans l'appelant, pour qu'aucun menu
  ne puisse oublier de le faire ; l'appelant referme et **rend le focus à son
  déclencheur**, la seule moitié qu'un helper ne peut pas faire à sa place.
- **⬆︎ ⬇︎ Début Fin** parcourent la liste, en bouclant aux deux bouts — un menu
  est une liste fermée. Depuis le déclencheur, ⬇︎ entre en haut et ⬆︎ en bas.
  Tab continue de fonctionner : le helper rend `null` sur toute autre touche.
- Le déclencheur porte `aria-haspopup` / `aria-expanded` et un `aria-label`
  complet (« Modèle : anthropic/claude-opus-4 », « Actions sur « … » » — vingt
  boutons nommés « Actions » dans une liste ne disent rien).
- **Le clic pose le focus sur le déclencheur** (`event.currentTarget.focus()`) :
  Safari ne focalise pas un bouton cliqué, et sans ça l'Échap suivant serait
  tapé sur `<body>` et repartirait vers la page.
- Les lignes de ces trois menus passent à 44 px sous 820 px. Dans celui d'une
  conversation, « Supprimer » était à 35 px juste sous « Archiver ».

**Mesuré au CDP sur l'application construite**, contre un faux gateway : menu
du modèle ouvert au clavier → ⬇︎ entre dans le champ de filtre puis sur le
premier modèle, Fin atteint le dernier, ⬇︎ reboucle en haut ; Échap referme,
`aria-expanded` repasse à `false`, le focus revient sur le déclencheur et **le
gestionnaire de la fenêtre ne voit pas la touche** (compteur à 0) — alors qu'un
second Échap, menu fermé, l'atteint bien (1). Idem sur le menu d'une ligne :
⬇︎ « Renommer », ⬆︎ reboucle sur « Supprimer », Échap referme sans toucher au
tiroir. En 414 × 896 : ⋯ à 44 × 44, les cinq actions à 44 px, les entrées du
sélecteur de modèle à 44 px.

**Le composeur en tenait deux de plus, et ce balayage-là les avait manquées.**
La bibliothèque de prompts (le signet) et la palette de skills (taper `/`) sont
des panneaux flottants ouverts depuis le composeur : mêmes obligations, et les
mêmes manques. **Mesuré au CDP en 414 × 896** sur l'application construite,
avant correction :

- **Échap n'était arrêté que dans le champ de saisie.** Tapé sur un contrôle
  *à l'intérieur* de la bibliothèque, il **laissait le panneau ouvert** et
  atteignait quand même le gestionnaire de la fenêtre (compteur à 1) — c'est-à-dire
  `chat.stop()` pendant qu'une réponse s'écrivait. Et la palette `/`, elle,
  se refermait bien mais laissait passer la touche tout de même : son `Escape`
  n'appelait ni `preventDefault()` ni `stopPropagation()`.
- **Les cibles tactiles étaient les plus petites de l'app** : le ✕ de la
  bibliothèque à **22 × 14 px**, et son « supprimer » à **28 × 24 px** collé à
  une ligne de 332 px qui, elle, *insère* le prompt. Un doigt qui rate jetait un
  prompt enregistré au lieu de s'en servir — la même forme d'erreur que
  « Supprimer » à 35 px sous « Archiver ».
- **La palette `/` naviguait en aveugle**, exactement comme la palette de
  commandes avant le point ci-dessous : huit correspondances font 350 px de
  lignes dans une boîte de 260 px, et amener le curseur sur la dernière la
  laissait à **301 px du haut d'une liste haute de 260**, `scrollTop` toujours à
  0. ↵ lançait alors un skill qui n'avait jamais été affiché. Ses lignes
  n'étaient enfin ni annoncées (aucun `role`, aucun `aria-selected`) ni retirées
  de la tabulation, alors que les flèches les parcourent déjà depuis le champ.

Les deux passent donc par le contrat commun : `menuKeydown` pour la
bibliothèque — qui rend le focus à son déclencheur, et dont le déclencheur
porte `aria-haspopup` et se focalise au clic (Safari) —, et pour la palette `/`
un `role="listbox"` dont les lignes sont des `role="option"` en `tabindex="-1"`,
pointées par l'`aria-activedescendant` du champ et ramenées dans la vue par
`scrollIntoView({ block: 'nearest' })`. **Re-mesuré après** : Échap n'atteint
plus la fenêtre (0) et referme vraiment, ⬇︎ depuis le signet entre dans le
panneau et reboucle, la dernière des huit lignes est visible (`scrollTop` 100,
haut à 216 d'une liste de 260), et tout ce qui se tape dans ces deux panneaux
fait 44 px. `tests/a11y.test.ts` compte maintenant le composeur parmi les
surfaces à menu, aux mêmes conditions que les trois autres.

**Et la palette de commandes est le quatrième — celui qui naviguait en
aveugle.** ⌘K ouvre un dialogue dont le focus reste dans le champ pendant que
⬆︎ ⬇︎ déplacent un curseur *visuel* dans la liste en dessous. Trois défauts en
découlaient, tous invisibles sur une capture d'écran :

- **Le curseur sortait de l'écran.** `.rows` défile (`max-height` 70 vh, 60 dvh
  sur téléphone) et, avec une douzaine de conversations plus les passages du
  fil ouvert (point 28), la liste dépasse largement. Le curseur, lui, ne
  suivait pas : douze ⬇︎ déplaçaient un repère que personne ne voyait, et ↵
  ouvrait quelque chose qui n'avait jamais été affiché. `scrollIntoView({ block:
  'nearest' })` sur la ligne active, à chaque déplacement **et** à chaque
  changement de liste.
- **Rien n'était annoncé.** Le champ est maintenant un `role="combobox"` avec
  `aria-activedescendant` qui pointe la ligne active, la liste un
  `role="listbox"`, chaque ligne un `role="option"` + `aria-selected`. Or un
  listbox ne peut contenir que des options et des groupes : les intitulés
  (« Actions », « Conversations », « Dans cette conversation ») ne pouvaient
  plus rester des paragraphes égarés entre les lignes. D'où `groupOptions()`
  (`src/lib/a11y.ts`, pure et testée) qui replie le tableau **plat** en groupes
  `role="group"` — chaque option emportant son **indice plat**, parce que le
  curseur est un indice dans ce tableau et qu'un groupe qui renumérote ses
  lignes surlignerait l'une pendant qu'↵ en ouvre une autre. Le tableau plat
  reste la source de l'arithmétique des flèches, comme au point 28.
- **Les lignes étaient des arrêts de tabulation**, et `aria-modal="true"` était
  un mensonge : Tab traversait trente résultats puis sortait dans la page
  derrière le voile. Elles passent en `tabindex="-1"` (le champ est le seul
  arrêt) et le dialogue reprend `trapTab` du point 22. Fermer ne déplace
  **pas** le focus, délibérément : choisir « Prompt : … » le pose dans le
  composeur, et le rendre au déclencheur l'en arracherait aussitôt.

Ce dernier point a demandé une correction dans `FOCUSABLE_SELECTOR` :
`button[tabindex="-1"]` correspond quand même à `button:not([disabled])`, donc
l'exclusion est maintenant répétée sur **chaque** entrée du sélecteur et non
laissée à la dernière. Les flèches, enfin, réutilisent `menuIndex()` plutôt
qu'un second modulo écrit à la main — mais **seulement** ⬆︎ ⬇︎ : Début et Fin
appartiennent au champ de saisie d'un combobox éditable. Et les lignes passent
à 44 px sous 820 px, comme le reste des listes de l'app.

**Non vérifié** : l'annonce réelle par VoiceOver ou NVDA, et le défilement dans
un vrai navigateur. Aucun n'était disponible dans le clone où ce changement a
été écrit — ce qui est testé, c'est la fonction pure et le fait que le balisage
la branche (`tests/a11y.test.ts`).

Dernier point du même ordre : un `<input type="file">` en `display: none` n'est
**pas** dans l'ordre de tabulation, et son `<label>` ne peut pas prendre le
focus à sa place — joindre une image était à la souris uniquement. L'input est
donc masqué en 1 px transparent, et c'est le label qui porte l'anneau.

### 23. Une conversation compressée change d'identifiant

La compression de contexte est **activée par défaut** dans Hermes
(`compression.enabled`, seuil à 50 % de la fenêtre). Quand elle se déclenche,
elle ne réécrit pas la session : elle la **termine**
(`end_reason = "compression"`) et crée une session enfant qui reçoit le résumé
et tous les messages suivants (`hermes_state.py`, `resolve_resume_session_id`).
Une conversation longue change donc d'`id` sans prévenir.

`GET /api/sessions` masque ça à la sidebar : `list_sessions_rich` tourne avec
`project_compression_tips=True`, suit la chaîne jusqu'à sa pointe et fusionne
la ligne — une conversation logique reste **une** ligne, à sa place dans le
tri. Mais la ligne porte alors l'`id` de la **continuation**, et l'ancien dans
`_lineage_root_id` (exposé par `_session_response`).

Or tout ce que cette app range par `session_id` vit dans `session_meta` :
l'agent de la conversation (point 18), son effort de réflexion (point 34) et le
cache de titre. Sans rien faire, une conversation perdait donc **sa persona au
moment précis où Hermes la compressait**, et repassait en silence au prompt par
défaut du gateway.

- `lineageRotations()` / `rotatedSessionId()` (`src/lib/sessions.ts`, purs et
  testés) lisent ces rotations dans une liste.
- Côté serveur, `GET /api/sessions` appelle `inheritSessionMeta(root, tip)`
  **avant** de décorer les lignes. La continuation garde ses propres valeurs si
  elle en a, et rien n'est écrit quand rien ne change : ce code tourne à chaque
  rafraîchissement de sidebar, sur une carte SD.
- Côté client, `refreshSessions()` déplace `chat.sessionId` sur la nouvelle
  ligne — **jamais pendant un tour**, le flux en vol étant lié à l'id avec
  lequel il a démarré. Sans ça, le message suivant partirait sur l'ancien id,
  dont `_conversation_history_for_session` rejouerait tout le transcript
  d'avant compression (`get_messages_as_conversation` ne suit pas la chaîne).

**Mais le tour lui-même le dit, et plus tôt que la sidebar.** `assistant.completed`
et `run.completed` portent le `session_id` **effectif** — celui sur lequel
l'agent a réellement écrit. Ce n'est pas une déduction : `_run_agent` pose
`result["session_id"] = agent.session_id` avec, en commentaire amont, « so
callers can track compression-triggered session rotations ». Attention, ces
**deux événements seulement** : `_event_payload` remplit `session_id` par
défaut avec l'id *demandé* sur toutes les autres trames, `run.started` et
`assistant.delta` comprises. Le rendre exploitable tient en deux moitiés :

- Côté serveur, `applyTurnFrame()` le retient dans `TurnSummary.sessionId` et
  `adoptRotation()` (`server/turns.ts`) appelle `inheritSessionMeta()` **à la
  fin du tour**, pas au prochain listing. C'est ce qui compte : sinon le message
  suivant est composé avec un `system_message` vide, parce qu'il part sur un id
  que `session_meta` n'a jamais vu. **Mesuré** sur l'application construite,
  contre un faux gateway qui annonce la rotation dans ses trames terminales :
  avec le changement, `sess-new` porte le titre et l'agent de `sess-old` dès la
  fin du tour ; sans lui, la table n'a toujours qu'une ligne. La notification
  part elle aussi sur l'id de la continuation, donc `?s=<id>` ouvre la ligne que
  la sidebar affichera.
- Côté client, `#adoptStreamRotation()` déplace `chat.sessionId` et le brouillon
  dans le `finally` de `send()`, **avant** le `refreshSessions()` qui suit. La
  ligne de sidebar est reportée sur le nouvel id par `renameSession()`
  (`src/lib/sessions.ts`, pure et testée) plutôt que jetée : sans ça,
  `chat.current` serait indéfini le temps d'un aller-retour et les sélecteurs de
  modèle et d'agent afficheraient « aucun ». `refreshSessions()` reste le filet
  pour une compression survenue app fermée — sur une ligne déjà reportée,
  `rotatedSessionId()` ne trouve plus rien à faire.

**Ce qu'on ne fait délibérément pas** : se fier au `session_id` renvoyé par
`GET /api/sessions/{id}/messages`. Ce handler résout par
`resolve_resume_session_id`, dont la seconde passe suit `parent_session_id`
vers l'enfant le plus récent en excluant les marqueurs `_branched_from` /
`_delegate_from` — or `_handle_fork_session` crée son enfant par
`db.create_session(..., parent_session_id=...)` **sans écrire ce marqueur**.
Ouvrir le parent d'un fork peut donc renvoyer le transcript du fork. Le champ
`_lineage_root_id`, lui, ne vient que de `get_compression_tip`, qui exige
`parent.end_reason == 'compression'` : c'est le seul signal non ambigu.

### 24. Les dates de la sidebar se comptent en jours, pas en heures

`relativeTime()` et `groupSessions()` (`src/lib/sessions.ts`) rangent une
conversation par **jour calendaire local** — 0 aujourd'hui, 1 hier — et non par
temps écoulé. C'est ce que les libellés promettent : une conversation de 23 h 50
est « hier » dix minutes plus tard, et celle de ce matin reste sous
« Aujourd'hui » jusqu'au soir.

D'où `localDay()`, qui projette l'année/mois/jour **locaux** sur `Date.UTC`
avant de soustraire. La version évidente — deux instants soustraits puis divisés
par 86 400 000 — se trompe d'un jour à **chaque** changement d'heure, dans les
deux sens, parce que le jour local dure alors 23 h ou 25 h. **Mesuré** avant
correction, sur les deux zones (Asia/Jerusalem, celle du Pi, et Europe/Paris) :
au lendemain du passage à l'heure d'hiver, une conversation de la veille
s'affichait « 2 j » et tombait dans « 7 derniers jours » ; au lendemain du
passage à l'heure d'été, une conversation d'avant-hier devenait « hier ». Un
horodatage tombant pile à minuit local était décalé lui aussi — « hier » pour
aujourd'hui.

Les deux fonctions prennent un `now` facultatif — même convention que
`parseSchedule()` au point 14 — parce qu'une bascule d'heure ne se teste pas
sans horloge fixe. `tests/sessions.test.ts` rejoue les deux transitions de 2026
dans les deux zones ; ces cinq cas échouent sur l'ancienne arithmétique.

### 25. Le message pas encore envoyé appartient à sa conversation

Le composeur est monté **une seule fois** pour toute l'application : son texte
ne se vidait donc pas en changeant de conversation, il **suivait**
l'utilisateur. Une demi-question écrite pour un agent se retrouvait à un Entrée
près d'être envoyée à un autre. Et une PWA installée est tuée sans préavis en
arrière-plan — sur iPhone, au bout de quelques minutes : le texte à moitié tapé
n'existait plus au retour.

D'où un brouillon **par conversation**, gardé côté navigateur
(`localStorage`, clé `hermes-drafts`). Les règles sont dans `src/lib/drafts.ts`
(pur, testé), l'accès navigateur dans `src/lib/stores/drafts.svelte.ts` :

- La clé est l'`id` de la conversation, ou `new` pour ce qui est tapé avant
  qu'il y en ait une. `Composer.svelte` retient l'id auquel son texte
  appartient (`boundId`) : quand `chat.sessionId` change, il **gare** le texte
  sur la conversation qu'on quitte et **reprend** celui de la conversation
  qu'on ouvre. L'effet est lu en `untrack()` pour ne dépendre que de l'id, pas
  de chaque frappe.
- **Rien n'est jamais tronqué.** Un brouillon plus long que
  `MAX_DRAFT_CHARS` (100 000 caractères) n'est simplement pas persisté, et
  l'entrée périmée est retirée : un texte qui reviendrait raccourci serait
  envoyé raccourci, sans que rien ne le dise. Il reste en mémoire tant que la
  page vit.
- Les bornes sont 24 conversations et 120 000 caractères au total, les plus
  anciennes évincées d'abord — **jamais celle qu'on est en train d'écrire**, ce
  qui serait exactement l'inverse du besoin. Au-delà de 30 jours sans retouche,
  un brouillon est oublié à la lecture. `normalizeDrafts()` répare une ligne
  écrite par une version antérieure au lieu de jeter.
- Le stockage est **local**, pas serveur — contrairement aux prompts
  enregistrés (point 15) et au thème (point 19). Un brouillon est attaché à
  l'appareil où on l'a tapé ; le synchroniser voudrait dire arbitrer deux
  composeurs ouverts en même temps, et écraser le texte de l'un avec celui de
  l'autre.
- L'écriture est débouncée (700 ms) et **vidée sur `pagehide` et sur
  `visibilitychange`** : c'est l'événement qu'iOS émet avant de suspendre une
  PWA installée, donc le seul moment où le débounce coûterait quelque chose.
- Deux clés suivent la conversation : `deleteSession()` oublie le brouillon
  (et le remet si la suppression amont échoue), et une compression le
  **déplace** sur le nouvel id en même temps que `chat.sessionId`
  (point 23) — sinon il disparaîtrait avec l'ancien.
- La sidebar affiche un ✎ accentué sur toute ligne qui en porte un, avec le
  début du texte en infobulle : sans ça, un message écrit et jamais envoyé est
  invisible depuis n'importe quelle autre conversation.
- **Un tour refusé rend le message.** Le composeur se vide **avant** d'appeler
  `send()`, et il le doit : créer la conversation déplace `chat.sessionId`,
  donc la clé sous laquelle ce texte est rangé. Mais un tour refusé *avant
  d'avoir commencé* ne laissait alors le texte nulle part — ni dans le fil (la
  bulle utilisateur n'est posée qu'une fois l'identifiant obtenu), ni dans
  `localStorage` (`drafts.clear`), ni dans la boîte. **Mesuré** sur
  l'application construite, gateway arrêté : `POST /api/sessions` répond
  `502 hermes_unreachable`, `newSession()` rend `null`, et `send()` sortait là
  sans un mot. C'est l'état ordinaire après un
  `systemctl --user restart hermes-gateway` (point 10) — celui que le panneau
  Providers réclame à chaque clé enregistrée — ou celui d'un téléphone qui
  quitte le tailnet. `send()` rend donc un booléen : `false` veut dire « rien
  n'est parti, le texte est toujours à toi », et `Composer` le remet en place
  avec `restoreDraft()` (pur, testé). **Fusionné** et non substitué, dans
  l'ordre où il a été tapé, et **seulement dans le composeur où il a été
  écrit** : une conversation ouverte entre-temps voit le texte garé sur sa
  propre clé, parce que l'ajouter en tête d'une autre conversation est
  exactement l'échange que ce point entier existe pour empêcher.
- **Ce qui reste volontairement perdable** : un tour dont le flux casse *après*
  le POST. Le serveur possède le tour (point 16) et on ne sait pas s'il l'a
  reçu ; rendre le texte au composeur pendant que la réponse s'écrit ferait
  envoyer la même question deux fois. Là, la bulle est déjà dans le fil et le
  toast propose « Recharger ». `tests/drafts.test.ts` garde les deux moitiés du
  contrat : la fonction de fusion, et le fait que `send()` et `submit()` la
  branchent encore.

### 26. Le catalogue de modèles ne doit pas retarder la conversation

Ouvrir l'app lance plusieurs appels de front, et l'un d'eux n'est pas comme les
autres. `GET /api/model/options` ne lit pas un fichier : `_handle_model_options`
appelle `build_model_options_payload()`, qui reconstruit l'inventaire des
fournisseurs derrière un **cache disque d'une heure** et va rechercher les
catalogues des fournisseurs sur internet dès qu'il a expiré.

**Mesuré contre l'application en production sur ce Pi**, endpoint par endpoint :

| appel | à froid | à chaud |
|---|---|---|
| `/api/capabilities` | — | 5 ms |
| `/api/sessions?limit=200` | — | 6–60 ms |
| `/api/sessions/{id}/messages` | — | 6 ms |
| `/api/skills` | — | 26–88 ms |
| **`/api/models`** | **1,9 s** | **134 ms** |

`chat.init()` attendait les trois branches, dont `refreshCatalog()`, avant que
`boot()` puisse appeler `openSession()`. La requête du transcript ne pouvait
donc pas partir tant qu'une liste de modèles que personne n'a demandé à voir
n'était pas revenue — et une fois par heure, elle mettait deux secondes.

D'où : `init()` **démarre** le catalogue et ne l'attend pas. Rejoué contre
l'application qui tourne, six fois chacun, du premier appel à la fin du
transcript : **médiane 181 ms → 52 ms** à chaud, et ~1,9 s → ~50 ms sur le
premier chargement après expiration du cache.

Ce qui rend ça sûr, et qu'il ne faut pas défaire :

- Rien de ce qui est à l'écran au démarrage n'en dépend. L'entête affiche le
  modèle de la conversation ouverte (`chat.activeModel`, qui vient de la ligne
  de session), et le sélecteur de modèle, la palette `/` et le compteur
  d'outils sont des choses qu'on va chercher. Tous gèrent déjà
  `chat.models === null`, qui est leur état initial de toute façon.
- **Une exception, et une seule** : créer une conversation épingle un id de
  modèle sur la ligne de session, et un id que Hermes ne sait pas router fait
  échouer *chaque* tour (point 1). C'est `refreshCatalog()` qui valide
  `nextModel` contre ce qui est routable, donc `send()` appelle
  `catalogReady()` **avant** `newSession()`. La dette est payée là, une fois,
  et en pratique elle est déjà réglée : il a fallu taper un message d'abord.
  (Cette course existait déjà — `boot()` n'empêche pas de taper pendant qu'il
  charge —, elle est maintenant fermée explicitement.)
- Le catalogue est stocké **non rejetant** (`.catch(() => undefined)`) : rien
  ne l'attend jusqu'à un éventuel `catalogReady()`, et une promesse rejetée
  laissée en l'air atterrirait dans le filet `unhandledrejection` de
  `+layout.svelte`, transformant un échec silencieux en bandeau d'erreur.
- `refreshCatalog()` lance ses deux appels **de front** plutôt qu'à la suite :
  `/api/models` et `/api/skills` ne lisent pas la réponse l'un de l'autre, les
  enchaîner ajoutait juste la latence du lent à celle du rapide. Chacun garde
  son `catch` — un gateway qui n'arrive pas à lister ses modèles doit encore
  pouvoir lister ses skills.

`tests/boot.test.ts` relit la source : il échoue si `init()` réattend le
catalogue, si les deux listings redeviennent séquentiels, ou si `send()` cesse
d'attendre `catalogReady()` avant `newSession()`.

**Et le serveur ne le redemande plus à chaque fois.** Ne pas *attendre* le
catalogue le sortait du chemin critique du navigateur ; ça ne l'empêchait pas
d'être refait à l'identique à chaque ouverture de l'app. Or rien n'a changé
entre deux : `_handle_model_options` reconstruit l'inventaire, applique les
prix **et sonde le fournisseur personnalisé courant sur le réseau**
(`probe_current_custom_provider=True` dans `build_model_options_payload`) à
chaque appel.

`src/lib/server/cache.ts` garde donc la dernière réponse en mémoire —
`cachedRead()`, à un seul vol (`single-flight`) et *stale-while-revalidate* —
et `src/lib/server/catalog.ts` l'instancie pour `/api/model/options` avec cinq
minutes de fraîcheur. Au-delà, la réponse connue part **tout de suite** et le
rafraîchissement tourne derrière la requête ; un rafraîchissement qui échoue
garde l'ancienne, plutôt que de vider le sélecteur parce que le gateway a
cligné des yeux.

**Mesuré de bout en bout** sur ce Pi, application construite, contre un faux
gateway rejouant les latences relevées sur le vrai (2 740 ms au premier appel
après expiration du cache horaire de Hermes, 134 ms à chaud) :

| | avant | après |
|---|---|---|
| `GET /api/models`, 10 appels | 2,78 s puis 141–144 ms | 2,78 s puis **2–5 ms** |
| appels amont pour ces 10 | 10 | **1** |
| `POST /api/sessions`, 5 créations | 2,83 s puis 152–154 ms | 2,84 s puis **15–17 ms** |
| appels amont pour ces 5 | 5 | **1** |

La seconde ligne est celle qui compte : `POST /api/sessions` résout le modèle
par défaut du gateway, et il tourne **entre la touche Entrée du premier message
et le départ du tour**. Une conversation créée juste après l'expiration du
cache de Hermes coûtait presque trois secondes d'attente ; elle en coûte une
seule fois par démarrage du conteneur.

Deux choses à ne pas défaire :

- **Toute écriture par le dashboard jette le cache.** Une clé enregistrée ou
  supprimée, un compte connecté ou déconnecté, le modèle global déplacé :
  chacune change ce que le gateway sait router, et une conversation créée dans
  les cinq minutes suivantes serait épinglée sur l'ancien défaut. Le crochet
  est dans `dashboardJson()` — tout appel non-GET qui réussit appelle
  `invalidateModelOptions()` — plus le cas du sondage OAuth, la seule écriture
  qui nous arrive en GET (`status === "approved"`). Sur-invalider coûte un
  aller-retour ; sous-invalider coûte un mauvais modèle sur une ligne de
  session, c'est-à-dire **chaque tour en échec** (point 1).
- **Le cache est en mémoire, pas dans `data/hermes-web.db`.** Un catalogue se
  reconstruit ; un redémarrage est exactement le moment où il faut oublier
  celui d'avant. Et ça évite d'écrire 24 ko sur le disque à chaque
  rafraîchissement.

**Et la liste des skills suit la même règle.** Une fois le catalogue de modèles
servi depuis la mémoire, `GET /api/skills` est devenu l'appel le plus cher du
démarrage — et de loin. **Mesuré à travers le proxy en production sur ce Pi**,
dix échantillons chacun : `/api/skills` **25–28 ms (médiane 26)**, contre 7 ms
pour une liste de 200 conversations, 5 ms pour `/api/capabilities` et 1,4 ms
pour le catalogue de modèles désormais caché.

C'est un outlier parce que ce sont **deux** handlers amont et non un :
`_handle_skills` parcourt l'arbre des skills via `_find_all_skills`, et
`_handle_toolsets` recharge `config.yaml`, résout chaque toolset et va chercher
l'état d'abonnement Nous (`get_nous_subscription_features`) — le tout refait
depuis zéro à chaque appel.

Or rien là-dedans ne peut avoir changé entre deux ouvertures de l'app : Hermes
ne recharge pas ses skills à chaud (point 11), donc éditer un `SKILL.md` ne
change ce que `GET /v1/skills` annonce qu'après un
`systemctl --user restart hermes-gateway`. La durée de vie honnête de cette
réponse, c'est « jusqu'au prochain redémarrage du gateway » — cinq minutes de
fraîcheur sont largement dedans. Et ce que le navigateur en fait est une
palette `/`, un compteur d'outils et une ligne sur la carte d'accueil : des
choses qu'on va chercher, jamais ce dont un tour dépend.

**Mesuré de bout en bout** sur ce Pi, application construite, contre un faux
gateway rejouant les 26 ms relevées sur le vrai :

| | avant | après |
|---|---|---|
| `GET /api/skills`, 10 appels | 68 ms puis 25–32 ms | 56 ms puis **2–6 ms** |
| appels amont pour ces 10 | **20** (2 par appel) | **2** (un de chaque) |

L'écriture d'un `SKILL.md` (création ou remplacement) jette le cache, comme une
écriture du dashboard jette celui des modèles. Ça ne fait pas apparaître le
nouveau fichier dans la liste — seul un redémarrage du gateway le fera — mais
ça évite d'empiler notre fenêtre par-dessus la sienne.

`tests/cache.test.ts` couvre la politique (fenêtre de fraîcheur, réponse
immédiate en stale, vol unique, échec qui ne vide pas, invalidation pendant un
vol en cours) et relit la source pour que ni `getModelOptions` ni
`getSkills`/`getToolsets` ne reviennent directement dans une route, et que les
deux listings partent bien de front.

### 27. Un tour ne se voit pas seulement, il doit s'entendre

Tout ce qui dit à l'utilisateur qu'il se passe quelque chose pendant un tour —
le curseur qui clignote, les étapes d'outils qui s'empilent, la note
« affichage interrompu » — est peint dans un `<div>` ordinaire qu'aucune
technologie d'assistance ne surveille. Taper Entrée ne produisait donc **rien**
d'audible : ni confirmation, ni progression, et surtout aucun signal que la
réponse est arrivée, sur des tours qui durent régulièrement des minutes.

Trois choses, toutes petites, dans le même esprit que le point 22 :

- **Une zone live polie**, rendue par `+page.svelte`, dont le texte vient de
  `turnAnnouncement()` (`src/lib/a11y.ts`, pure et testée). Elle dit la
  **phase**, jamais le texte de la réponse : une zone polie alimentée par le
  flux relirait la réponse entière à chaque redessin, et le texte est de toute
  façon à une flèche de là dans le transcript. Les phrases : « Hermes
  réfléchit. », « Outil `<nom>` en cours. » (la plus récente étape `running`,
  c'est elle qui prend le temps), « Réponse en cours. », « Réponse terminée
  après N outils. », et les fins non nominales — erreur, détachement,
  troncature — qui l'emportent sur la phase.
- **Le gardien s'appelle `liveTurnId`** : un message ne devient annonçable
  qu'après avoir été vu **en train de streamer dans cet onglet**. Sans ça,
  ouvrir une conversation ferait annoncer « Réponse terminée. » à propos de la
  dernière ligne d'un transcript chargé depuis l'historique — une phrase qui ne
  parle de rien que l'utilisateur vienne de faire. Un `reload()`, qui remplace
  tous les messages par des ids neufs, redevient donc silencieux lui aussi.
- **Chaque message dit qui parle** (`<span class="sr-only">Vous :</span>` /
  `Hermes :`) : à l'oreille, un transcript n'est qu'une suite de paragraphes
  sans attribution — la bulle et son alignement sont une information purement
  visuelle. Et les deux boutons en glyphe du composeur (`↑`, `■`) portent
  enfin un `aria-label` : ils s'annonçaient « flèche vers le haut ». Le
  `aria-label` de la zone de saisie la nomme aussi de façon stable, plutôt que
  de laisser son nom basculer sur le placeholder « Hermes travaille… » en plein
  tour.

`.sr-only` est déclarée **une fois**, dans `src/app.css`, avec le découpage à
un pixel — `display: none` ou `visibility: hidden` la sortiraient aussi de
l'arbre d'accessibilité, ce qui est exactement l'inverse du but.
`tests/a11y.test.ts` vérifie les phrases, le gardien, les libellés et la règle
CSS.

**Non vérifié** : l'annonce réelle par VoiceOver ou NVDA. Aucun navigateur
n'était disponible dans le clone où ce changement a été écrit ; ce qui est
testé, c'est la phrase produite et le fait que le balisage la porte.

### 28. Retrouver un passage : la palette cherche aussi dans le fil ouvert

Le gateway n'a **aucune** route de recherche dans les messages : sa table de
routage (`api_server.py`, 0.20.0) n'expose sur les sessions que la liste, la
fiche, le transcript, le fork, le chat et le verrou de modèle — vérifié aussi
par l'absence totale d'un handler de recherche dans le fichier. Mais il n'en
faut pas : `openSession()` charge déjà tout le
transcript (`?order=oldest&limit=500`), donc « où est-ce qu'il m'a donné cette
commande ? » se répond dans le navigateur, sans un aller-retour.

Et c'est sur téléphone que ça compte : une PWA installée n'a pas de
« rechercher dans la page ». Sur desktop le Ctrl+F du navigateur trouve le
texte affiché ; il ne dit pas *combien* de fois, ni ne survit à un changement de
conversation.

Pas de nouvelle surface pour autant : c'est **la palette existante** (`⌘K`, ou
le bouton ⌕ de l'entête) qui gagne un troisième groupe de résultats, sous
« Dans cette conversation ». Un seul champ de recherche, trois natures de
résultat — actions, conversations, messages du fil — avec des intitulés de
groupe pour qu'on sache ce qu'on regarde. Choisir un message ferme la palette,
fait défiler le fil jusqu'à lui et l'entoure deux secondes et demie.

Les messages viennent **en dernier**, et c'est délibéré : dans un long fil,
presque n'importe quelle requête trouve quelque chose. Les placer en tête
chasserait de l'écran la conversation qu'on venait ouvrir — le premier métier
de cette palette.

`findInMessages()` (`src/lib/search.ts`, pure et testée) tient les règles :

- **Une ligne par message, pas par occurrence** : la palette offre un endroit
  où aller, et c'est un message qu'on sait faire défiler. Le nombre
  d'occurrences est reporté à droite (« 3× »). Les plus récents d'abord : la
  vue est en bas du fil, et dans une conversation la dernière mention est
  presque toujours celle qu'on cherche.
- **L'extrait est découpé dans le texte d'origine**, pas dans le texte replié :
  afficher « resume » là où le message dit « résumé » serait le citer faux.
  D'où le repli caractère par caractère qui garde, pour chaque caractère replié,
  l'indice de celui qui l'a produit. `normalize()` est la partie chère, donc
  elle est mémoïsée par caractère et l'ASCII ne l'atteint jamais : **mesuré sur
  ce Pi 5**, replier un mégaoctet de prose française coûte ~130 ms — et ce
  travail est mis en cache par message.
- **Le cache est invalidé par le texte, pas seulement par l'identifiant** : un
  message en train de streamer garde son id pendant que son contenu grandit.
  Sans la comparaison de la source, le tour en cours ne serait jamais trouvé.
- **Le calcul est conditionné à `open`.** La liste de lignes est lue par un
  effet (le curseur doit rester dans la liste quand elle rétrécit), donc une
  palette simplement refermée sur une requête laissée là replierait tout le
  transcript **à chaque token** du tour qui s'écrit derrière.
- Deux caractères minimum : en dessous, une requête trouve tellement de choses
  que les conversations seraient chassées de l'écran par le bruit.

**Ce qui n'est délibérément pas fait** : surligner le passage *dans la bulle*.
Le corps d'un message est du markdown assaini injecté en `{@html}` par un rendu
débouncé (point 9) ; y réécrire des balises reviendrait à se battre avec le
prochain redessin. L'extrait dit ce qui a été trouvé, le halo dit où — et le
halo est en `--focus`, donc lisible sur tous les préréglages (point 22).

**Non vérifié** : le rendu réel dans un navigateur. Aucun n'était disponible
dans le clone où ce changement a été écrit ; ce qui est testé, c'est la
fonction pure (`tests/search.test.ts`) et le fait que le balisage la branche.

**Et les autres conversations : le serveur va lire, parce que lui seul le
peut.** Le navigateur ne détient que le fil ouvert ; les quarante autres sont
sur le disque du Pi, derrière une API qui n'a **aucune** route de recherche
(vérifié à nouveau ci-dessus dans la table de routage). La seule façon
de répondre à « c'était dans quelle conversation ? » est donc de lire les
transcripts et de regarder — ce que le serveur fait en un aller-retour pour le
client, sur la boucle locale.

`GET /api/search?q=…` (`src/lib/server/search.ts`) est ce fan-out, et il est
borné sur chaque axe : les **40** conversations les plus récemment actives, **4**
sondes en vol, **3** extraits par conversation, la même fenêtre de 500 messages
que le fil ouvert. Rien ne le déclenche tout seul — `gate('search', 1, 3)`, et
la palette ne l'appelle **jamais à la frappe** : le groupe « Dans les autres
conversations » ne contient qu'une action tant qu'on ne l'a pas lancée, et la
réponse n'est gardée que tant que la requête qui l'a produite est celle qui est
tapée. Un `⌘↵` depuis le champ fait la même chose, parce que cette ligne est en
bas d'une liste qui peut être longue.

Trois choses qui rendent ça sûr, et qu'il ne faut pas défaire :

- **Le transcript est replié par `groupTranscript()` avant d'être fouillé.**
  L'identifiant d'un extrait est alors exactement le `data-mid` que le
  navigateur rendra après `openSession()` — chercher dans les lignes brutes
  rendrait des ids qui n'atteignent jamais le DOM, et le saut inter-conversation
  ne tomberait sur rien. C'est ce qui permet à `jumpToMessage(id, sessionId)`
  d'ouvrir la conversation **puis** de défiler jusqu'au passage.
- **`findInTranscript()` ne paie pas l'extrait d'un message qui ne matche
  pas.** La carte d'indices de `fold()` coûte un emplacement de tableau par
  caractère — acceptable pour le seul transcript qu'un navigateur tient,
  ruineux pour les quarante d'une requête. D'où deux passes : un repli **sans
  carte** pour décider, puis `findInMessages()` sur le seul message retenu, si
  bien que l'extrait est découpé par exactement le code du fil ouvert
  (`tests/search.test.ts` compare les deux sorties champ par champ).
- **Une conversation illisible ne vide pas le résultat** (supprimée en cours de
  route, hoquet amont) : la sonde rend `null` et les autres continuent. Les
  conversations en corbeille sont exclues comme dans la sidebar — les trouver
  ici contredirait le fait de les avoir supprimées.

Ce que l'UI en dit : le nombre de conversations réellement explorées, et « les
plus récentes seulement » quand il y en avait davantage. Un compte muet
laisserait croire à une recherche exhaustive.

**Non vérifié** : le rendu dans un vrai navigateur, pour la même raison que
ci-dessus. Ce qui est mesuré, c'est la route elle-même, jouée contre un faux
gateway : trois conversations, `?q=gateway` → l'extrait du message assistant et
celui du message utilisateur de la bonne conversation, `?q=resume` → « résumé »
cité **accentué** dans l'autre, `?q=a` → 400 `invalid_query`, et six lectures
amont pour deux recherches sur trois conversations.

Route : `GET /api/search?q=<requête>`.

### 29. Le langage visuel : l'élévation remplace le trait

L'app suivait une maquette d'affiches ; elle en suit maintenant la grammaire
entière. Une seule règle commande tout le reste : **rien n'est entouré d'une
ligne.** Une carte se distingue de la page parce qu'elle est plus claire
qu'elle et posée dessus, jamais parce qu'un `1px solid` en dessine le bord.

Ce que ça implique, et qu'il ne faut pas défaire :

- **Le fil est le fond creusé, pas la surface.** `main` est passé en
  `--bg-sunken` : sans ça une carte en `--bg-raised` n'aurait nulle part d'où
  se lever. C'est le renversement dont tout le reste découle — une bulle, une
  ligne de sidebar, un panneau flottant sont tous des surfaces **plus claires**
  que ce qui les porte.
- **Trois élévations, pas une.** `--shadow-card` (une carte au repos),
  `--shadow` (un panneau) et `--shadow-float` (ce qui survole les deux : le
  composeur, un menu surgissant, le bouton d'envoi). Elles sont **teintées avec
  la tonalité profonde de la palette** et non en noir neutre, pour qu'une ombre
  appartienne à son préréglage au lieu de le griser — d'où `rgba()` dans
  `theme.ts`. `tests/theme.test.ts` échoue si deux des trois niveaux
  redeviennent identiques : deux ombres égales aplatissent toute la hiérarchie
  sans que rien ne casse visiblement.
- **La carte d'accueil est le seul aplat saturé de l'app**, et elle porte du
  texte blanc sur un **dégradé**. Les deux extrémités doivent donc tenir ce
  texte, pas seulement celle que l'œil regarde : ce sont `--user-bubble` et
  `--hero-2`, c'est-à-dire les deux accents passés par `ensureContrast`, la
  fonction qui les assombrit jusqu'à ce que le blanc passe 4,5:1. Un dégradé
  composé autrement — vers `--rail`, vers un accent brut — n'a pas cette
  garantie. Les deux disques décoratifs sont tirés de `--user-ink` en
  `color-mix`, jamais d'un blanc littéral.
- **Les listes s'ouvrent par une pastille ronde.** Une ligne de sidebar porte
  l'emoji de son agent ou, à défaut, sa propre initiale ; une étape d'outil
  porte son icône dans un cercle. C'est ce qui remplace le liseré accentué de
  la ligne active — un liseré est un trait.
- **Les contrôles secondaires sont des chips ronds** (entête, composeur), et
  **l'action principale est un cercle plein** : le bouton d'envoi, et son
  pendant « Nouvelle discussion » dans la colonne.
- Les rayons ont pris un cran (`--radius-card` 14 → 18, `--radius-bubble`
  20 → 22, `--radius-panel` 26 → 28) et `--gap-card` dit l'écart entre deux
  cartes d'un même panneau, comme `--gap-panel` le dit entre deux panneaux.

Ce qui n'a **pas** changé : aucune couleur. Les seize préréglages, les deux
accents choisis et toute la dérivation `color-mix` du point 19 sont intacts —
seules trois ombres et un second ton de dégradé s'y ajoutent, tous dérivés des
couleurs déjà là. Une nouvelle couleur passe toujours par un token produit par
`themeVariables()`, jamais par un littéral dans un composant.

### 30. La corbeille : supprimer ne détruit plus, et c'est un choix d'architecture

`DELETE /api/sessions/{id}` supprime **pour de bon** côté Hermes — transcript,
appels d'outils, lignes FTS5. Il n'y a en amont ni suppression douce, ni
drapeau à emprunter, ni corbeille. Une corbeille n'est donc honnête que si
l'app **n'appelle jamais cet endpoint** avant l'échéance. C'est toute la
conception :

- **Supprimer** écrit `deleted_at` sur notre propre ligne `session_meta` et
  n'envoie rien en amont. La conversation reste intacte dans `state.db`.
- **Restaurer** efface ce champ. Il n'y a rien à reconstruire, puisqu'il n'y a
  rien eu à détruire — c'est exactement ce qu'on achète en n'appelant pas la
  suppression amont.
- **Le vrai `DELETE`** n'existe qu'à deux endroits : le balayage à échéance, et
  `?purge=true` (vider une ligne à la main, et le smoke test qui nettoie son
  fixture). `tests/trash.test.ts` échoue si l'appel amont ressort de cette
  branche : ce serait promettre une restauration que l'app ne pourrait pas
  tenir, sans que rien n'échoue avant que quelqu'un essaie.

**L'alternative rejetée** : supprimer en amont et garder une copie du
transcript chez nous pour le rejouer à la restauration. Impossible à tenir —
recréer une session donne un nouvel id, et `POST /v1/runs` aplatit
`conversation_history` en `str(content)` (point 2) : adieu les `tool_calls`
structurés et le multimodal. On rendrait un décalque, pas la conversation. Une
restauration qui ment est pire que pas de restauration.

**Les trente jours ont été vérifiés en amont, pas supposés.** Deux réglages
pouvaient les contredire (`hermes_state.py`, `config_defaults.py`, 0.20.0) :
`sessions.auto_archive` archive et ne supprime jamais (« non-destructive
sibling », défaut `false`), et `sessions.auto_prune` **est** destructif mais
vaut `false` par défaut, exige 90 jours d'inactivité et ne touche que les
sessions terminées. Cette machine n'a aucun bloc `sessions:` dans
`~/.hermes/config.yaml` : les deux défauts s'appliquent. Ne pas allonger le
délai au-delà de 90 jours sans revérifier ce point.

Le reste, dans le code :

- **Une conversation en corbeille est toujours vivante en amont**, donc elle
  revient dans chaque `GET /api/sessions` et c'est le proxy qui la retire
  (`trashedIds()`). C'est le prix d'une suppression qui ne détruit rien. C'est
  aussi ce qui rend la panne **sûre** : perdre `data/hermes-web.db` fait
  réapparaître les conversations au lieu de les rendre introuvables — l'inverse
  du choix qu'aurait été « archiver en amont pour les cacher ».
- **Limite assumée** : tant qu'elle est en corbeille, la conversation reste
  visible depuis le CLI et Telegram. Elle n'est pas supprimée, elle est en
  attente ; le mentir serait pire.
- **Le balayage n'a pas d'ordonnanceur** : il part d'un rafraîchissement de
  sidebar, la seule requête qui arrive quand quelqu'un regarde. Bridé à une
  passe par heure, plafonné à 5 suppressions, et **jamais propagé en erreur** —
  une ligne balayée un rafraîchissement plus tard ne gêne personne, une sidebar
  qui échoue si.
- **`deleted_at` compte à rebours vers le bas** (`trashState`, pure et testée) :
  29,9 jours restants s'affichent « il reste 29 jours », jamais 30. Un chiffre
  qui promet de la récupérabilité doit se tromper du côté pessimiste.
- **La suppression ordinaire ne demande plus confirmation** : elle est
  réversible, et un `confirm()` sur une action annulable apprend à cliquer sans
  lire. Le toast porte « Annuler », la corbeille porte le reste. Seul
  `purgeSession()` demande — celui-là est définitif.
- **Le brouillon survit à la suppression** : `deleteSession()` ne l'efface plus,
  seul `purgeSession()` le fait. Jeter une conversation ne doit pas jeter le
  message qu'on n'a pas envoyé.

Routes : `DELETE /api/sessions/{id}` (corbeille, ou `?purge=true` définitif),
`POST /api/sessions/{id}/restore`, `GET /api/sessions?trashed=true`.

### 31. Une seule porte pour les réglages, et des icônes dessinées

Deux corrections d'un même défaut : l'interface se donnait l'air d'un
brouillon.

**Le pied de la sidebar était une étagère, pas un menu.** Sept boutons emoji
enroulés sur trois rangées inégales, dans l'ordre où ils avaient été ajoutés.
Ils sont maintenant **une porte** — « Réglages » — et `SettingsPanel.svelte`
les range en trois familles selon ce sur quoi ils agissent : *Conversations*
(archivées, corbeille), *Agent* (agents, tâches, skills, providers),
*Application* (apparence, raccourcis, état). Le rail replié suit la même
règle : un engrenage au lieu de cinq pictogrammes.

- **Le hub est un couloir, pas une destination** : `go()` ferme le panneau
  *avant* d'ouvrir ce que l'entrée désigne. Deux dialogues empilés, c'est deux
  pièges de tabulation qui tirent en sens inverse — exactement le problème du
  tiroir au point 22. `tests/a11y.test.ts` échoue si une entrée court-circuite
  `go()`.
- La sidebar n'a donc plus que **deux** sorties (`onopenSettings`,
  `onopenStatus`) au lieu de six, et expose `showList()` pour que le hub puisse
  changer la liste de la colonne sans en tenir une copie.

**Les emoji ne sont pas un jeu d'icônes, c'est une police.** Chaque plateforme
dessine les siens : la même timeline n'avait pas la même tête sur le téléphone
et sur le bureau, les couleurs échappaient au thème (un 🟢 « en bonne santé »
n'était pas le `--ok` de la palette), la taille suivait celle du texte et le
tout se posait sur une ligne de base au lieu d'une grille.

`src/lib/icons.ts` déclare donc une quarantaine de tracés sur une grille
24×24, rendus par `Icon.svelte` en `currentColor` : une icône prend la couleur
du contrôle qui la porte et suit les seize palettes du point 19 gratuitement.
Aucune dépendance — une librairie d'icônes, ce sont des kilo-octets de
JavaScript sur le chemin de démarrage d'un Pi pour quelques dizaines de
chemins.

Trois points à ne pas défaire :

- `toolIcon()` et `jobState().icon` rendent un **nom d'icône**, plus un glyphe,
  et leur type de retour le dit : `IconName`, pas `string`. Cette distinction
  n'est pas cosmétique — c'est `string` qui a laissé les deux endroits que la
  migration avait manqués vivre six jours sans que rien n'échoue. Un nom
  d'icône ne se concatène donc **jamais** dans une chaîne affichée : il se
  passe à `<Icon name={…}>`.
- Les pastilles d'état sont des `<span>` colorés par `--ok` / `--accent` /
  `--danger`, plus des ronds emoji.
- **`agentLabel()` garde l'emoji, et c'est voulu.** Cette chaîne est recopiée
  telle quelle dans chaque prompt système et dans le prompt de chaque tâche
  planifiée, et une tâche compare son prompt à une recomposition fraîche pour
  savoir si sa fiche est périmée (point 14). La changer marquerait toutes les
  tâches à agent comme « à mettre à jour », pour un caractère qu'aucun modèle
  ne lit différemment. L'interface, elle, affiche `agentInitial()` — une
  pastille colorée portant l'initiale, comme les lignes de conversation.
- Le champ Emoji a disparu du formulaire d'agent, mais **la colonne continue
  d'être écrite** : retirer un champ est une chose, effacer ce que quelqu'un y
  a tapé en est une autre.

`tests/icons.test.ts` vérifie que chaque `<Icon name="…">` des composants
existe dans le jeu, que chaque tracé est bien du path data, que les cinq états
d'une tâche planifiée pointent sur une icône réelle, et **qu'aucun composant ne
contient plus un seul emoji** — c'est le garde-fou contre la rechute.

Ce dernier test ne lit que les `.svelte`, et c'est précisément par là que la
rechute est passée : `jobState()` vit dans `src/lib/jobs.ts`, que le balayage ne
regarde pas. Élargir le balayage aux `.ts` ne marcherait pas — `agents.ts` garde
les emoji de ses fiches par défaut (point ci-dessus) et `approvals.ts` cherche
le `⚠️` du marqueur amont. C'est donc le **type** qui tient ce rôle hors des
composants : un glyphe ne s'assigne pas à un `IconName`, et `npm run check`
échoue avant que quiconque regarde l'écran.

### 32. La politique d'approbation : trois leviers qui ne se comportent pas pareil

Le panneau « Approbations » lit et écrit la politique de Hermes **par le
dashboard**, jamais en éditant `config.yaml` nous-mêmes — même règle que les
identifiants de providers (point 13). Et jamais en relayant la config :
`GET /api/config` répond ~90 clés racine dont des identifiants recopiés
depuis `.env`. Exactement **trois champs** sortent de
`src/routes/api/approvals/+server.ts`, extraits côté serveur comme
`groupProviderKeys()` le fait pour `GET /api/env`.

Les trois leviers, et la mesure qui les distingue (0.20.0) :

| Réglage | Effet | Pourquoi |
|---|---|---|
| `approvals.mode` | **immédiat** | lu par `_get_approval_config()` → `load_config_readonly()`, dont le cache est indexé sur `(mtime_ns, taille)` du fichier |
| `approvals.deny` | **immédiat** | même chemin |
| `command_allowlist` | **redémarrage du gateway** | `_command_matches_permanent_allowlist()` lit `_permanent_approved`, un set de module rempli une seule fois par `load_permanent_allowlist()` à l'import |

Dire « les changements sont pris en compte immédiatement » serait vrai aux
deux tiers, c'est-à-dire faux.

Ce qui compte dans le code :

- **`PUT /api/config` fusionne en profondeur, mais une liste est remplacée en
  entier**, pas fusionnée élément par élément. Composer une politique sur une
  lecture qui a échoué n'écrirait donc pas « les défauts » : ça **effacerait**
  les règles de refus de l'utilisateur — celles qui bloquent une commande même
  sous `--yolo`. D'où `planPolicyUpdate()` et un `baseline` nul tant que le GET
  n'a pas répondu, exactement comme le thème (point 19) et la bibliothèque de
  prompts (point 15).
- **Vérifié contre le dashboard réel** : après un `PUT` ne portant que
  `approvals.{mode,deny}` et `command_allowlist`, les six autres clés du bloc
  `approvals` (`timeout`, `cron_mode`, `smart_policy`,
  `denial_breaker_threshold`, `mcp_reload_confirm`,
  `destructive_slash_confirm`) et les 89 clés racine étaient intactes.
- **Mais la sauvegarde réécrit `config.yaml`** : le `save_config` du dashboard
  ré-sérialise le fichier et **ne conserve pas les commentaires écrits à la
  main**. Constaté en développant ce panneau — un bloc de commentaires de
  l'utilisateur a disparu et a dû être restauré depuis une copie. Le panneau le
  dit maintenant en toutes lettres. Ce n'est pas propre à ce panneau : toute
  écriture de config par le dashboard a cet effet.
- **Le mode `manuel` prive cette interface de tout recours** : Hermes n'expose
  de bouton d'approbation que sur le CLI et les messageries (point 8), donc en
  manuel chaque commande dangereuse s'arrête ici sans issue. Le panneau
  l'affiche en avertissement plutôt que de laisser le choix se retourner contre
  l'utilisateur.
- **`off` désactive la garde partout**, pas seulement ici — d'où la
  confirmation. Le plancher de sécurité (`rm -rf /`, `mkfs`, écriture disque
  brute) reste, lui, hors de portée de ce réglage.

Route : `GET|PUT /api/approvals`.

### 33. Le catalogue de modèles dit déjà le prix — et le sélecteur en cachait vingt

`GET /api/model/options` ne renvoie pas qu'une liste de noms.
`build_model_options_payload` (`hermes_cli/inventory.py`) l'appelle avec
`pricing=True`, `capabilities=True` et `featured=True`, et `_apply_pricing`
ajoute alors sur chaque ligne de fournisseur qui a un catalogue vivant
(openrouter / nous / novita) :

```
row["pricing"] = {model_id: {"input": "$3.00" | "free" | "",
                             "output": …, "cache": … | null, "free": bool}}
```

Les montants sont **déjà formatés** par le serveur, par million de jetons : le
navigateur n'a rien à calculer et surtout rien à arrondir lui-même. Nous les
ignorions entièrement. **Relevé sur cette machine** contre l'application en
production : les 49 modèles d'OpenRouter portent tous un prix, de `free` à
`$30.00`, dont 8 gratuits — de quoi choisir, et jusqu'ici invisible.

`modelEntries()` / `priceLabel()` / `priceDetail()` (`src/lib/models.ts`, purs
et testés) sont les trois fonctions qui traduisent ça. Trois règles :

- **Aucune supposition.** Un fournisseur sans catalogue (anthropic, copilot
  ici) n'a pas de clé `pricing` : la ligne n'affiche alors **rien**, jamais
  « gratuit ». Un prix à moitié connu s'affiche à moitié.
- **`unavailable_models` est respecté.** Upstream y range les modèles payants
  qu'un compte Nous en palier gratuit ne peut pas prendre. Les proposer, c'est
  épingler sur une ligne de session un modèle que Hermes refusera ensuite à
  **chaque** tour (point 1). La liste est vide dès que le test de palier ne
  s'applique pas ou échoue, donc la respecter ne peut retirer qu'un modèle déjà
  condamné.
- Le prix détaillé (`entrée · sortie · cache`) est l'infobulle de la ligne ; le
  libellé visible tient en `$2.00 / $10.00 par Mtok`.

**Et le plafond de la liste ne ment plus.** Le menu tranchait à
`.slice(0, 60)`, sans rien dire. **Mesuré ici** : 80 modèles servables
(49 openrouter + 17 copilot + 13 anthropic + 1 moa), donc **20 inatteignables**
à moins de deviner un filtre qui les fasse remonter — dont la totalité de
Copilot. `pickModels()` rend maintenant `{shown, hidden}`, le plafond est à
100, et ce qu'il coupe est annoncé (« N modèles de plus — affinez le filtre »).
Le filtre porte aussi sur le **fournisseur** : son nom est écrit sur chaque
ligne, taper « copilot » devait marcher.

Détail de mise en page à ne pas défaire : une ligne du menu est maintenant sur
deux niveaux (l'identifiant, puis prix + fournisseur) et porte `flex: none`.
`.items` est une colonne flex, et sans ça la règle tactile `min-height: 44px`
devenait une hauteur *imposée* — mesuré en 414 × 896, la première ligne de
chaque entrée était rognée.

### 34. L'effort de réflexion : Hermes l'accepte à chaque tour, l'UI ne l'envoyait jamais

Le corps d'un tour de `POST /api/sessions/{id}/chat/stream` peut porter un objet
`model_options`, et `_request_reasoning_config()` y lit
`reasoning.{enabled, effort}` pour le poser sur `AIAgent(reasoning_config=…)` —
**vérifié** dans `api_server.py` (0.20.0), ligne 2886 : une valeur explicite de
la requête l'emporte sur `agent.reasoning_effort` de `config.yaml`. C'est le
même levier que le `/reasoning` du CLI. Rien de nouveau n'est demandé à Hermes ;
simplement, ce champ partait vide depuis toujours.

Deux propriétés de ce code amont commandent tout le reste :

- **Les niveaux acceptés sont un ensemble fermé** (`_REASONING_EFFORTS` :
  `none | minimal | low | medium | high | xhigh`), et ce qui n'y est pas est
  **ignoré** au lieu d'être refusé — le tour tourne alors sur le réglage du
  gateway. Un niveau inconnu ne peut donc pas faire échouer un tour, mais il
  peut ne rien faire en silence : d'où `auto` comme **choix explicite** de cette
  app plutôt qu'une chaîne hors borne, et un 400 sur
  `POST /api/sessions/{id}/reasoning` quand la valeur n'est pas reconnue.
- **`model_options` reste à portée de requête**, dans les mots d'amont
  (« model_options stay request-scoped regardless of which selection wins »).
  Rien n'est retenu sur la ligne de session, donc la valeur doit repartir **à
  chaque message** — exactement comme le `system_message` d'un agent (point 18),
  et pour la même raison elle est composée **côté serveur** : le navigateur n'a
  pas voix au chapitre, sinon deux onglets pourraient se contredire sur la façon
  dont une conversation réfléchit.

**Ce qui rend le levier sûr**, et qu'il faut vérifier avant d'en ajouter un
autre : chaque plugin de fournisseur traduit `reasoning_config` pour son propre
protocole dans `build_api_kwargs_extras` — OpenRouter en `extra_body.reasoning`,
Copilot en rabattant le niveau sur ce que son catalogue vivant annonce,
Anthropic en `thinking` (sauté sur Haiku), et les Claude à réflexion obligatoire
reçoivent `verbosity` et **aucun** champ `reasoning`, précisément parce qu'un
`{enabled: false}` les faisait répondre 400. Un fournisseur sans surcharge
l'ignore. Le pire cas est donc un niveau sans effet, jamais une requête refusée.

Le stockage est à nous : colonne `reasoning` de `session_meta`
(`data/hermes-web.db`), `auto` étant stocké en NULL — l'absence d'opinion est ce
qu'a une conversation qu'on n'a pas touchée. Trois conséquences dans le code :

- `GET /api/sessions` et `GET /api/sessions/{id}` ajoutent `reasoning` à la
  ligne, comme ils ajoutent `agent_id` (point 18) : ce n'est **pas** un champ
  Hermes, et pour la raison inverse — le gateway ignore ce qu'est une persona,
  et il oublie volontairement les `model_options` d'un tour.
- `inheritSessionMeta()` le transporte lors d'une rotation de compression
  (point 23). Sans ça une conversation longue perdrait son effort au moment
  précis où Hermes la compresse. **Mesuré** contre un faux gateway qui annonce
  la rotation : `sess-2` hérite bien de `xhigh` et la ligne de continuation
  arrive décorée.
- `src/lib/reasoning.ts` (pur, testé) tient l'ensemble fermé, la normalisation
  et la charge utile. `none` part en `{enabled: false}` et non en
  `{effort: 'none'}` : amont traite les deux à l'identique et le booléen est la
  forme que lisent tous les plugins.

Le sélecteur de modèle a gagné une rangée de pastilles « Réflexion » plutôt
qu'un quatrième menu surgissant : le contrat clavier du point 22 est déjà celui
de ce menu (`menuStops` ramasse les nouveaux arrêts tout seuls, Échap y est déjà
arrêté), et un dialogue de plus aurait voulu dire un piège de tabulation de
plus. Le déclencheur affiche une pastille accentuée quand la conversation
**s'écarte** du réglage de Hermes — jamais pour `auto`, qui est le point de
départ de tout le monde — et son `aria-label` la nomme.

`modelDoesReasoning()` s'appuie sur la carte `capabilities`
(`{modèle: {fast, reasoning}}`) que `/api/model/options` publie déjà, construite
par `_apply_capabilities` (`hermes_cli/inventory.py`) depuis le catalogue
models.dev. Amont met ce drapeau à `true` pour un modèle qu'il ne connaît pas —
cacher le levier à un modèle capable mais non catalogué est le pire échec — et
on fait pareil. **Relevé sur cette machine** : les 81 modèles servables
l'annoncent tous à `true`, donc ça ne cache rien aujourd'hui ; c'est là pour que
l'app cesse de **promettre** un levier le jour où un modèle catalogué sans
réflexion apparaît.

**Mesuré de bout en bout** sur l'application construite, contre un faux gateway
qui journalise le corps de chaque tour : sans réglage → aucun `model_options` sur
le fil ; `high` → `{reasoning:{enabled:true,effort:"high"}}` ;
`none` → `{reasoning:{enabled:false}}` ; retour à `auto` → le champ disparaît
à nouveau ; `"ultra"` → `400 invalid_body`. **Non vérifié** : le rendu des
pastilles dans un vrai navigateur (aucun n'était installé dans le clone où ce
changement a été écrit) et l'effet réel sur un tour, qui dépend du fournisseur.

**Ce qui n'est délibérément pas fait** : le second levier que
`_runtime_options_from_model_options` accepte, `service_tier` / `fast`
(→ `service_tier: "priority"`). C'est un palier de facturation et non un réglage
de qualité, et `capabilities[modèle].fast` est la seule chose qui dit s'il
s'applique — à traiter séparément, ou pas du tout.

Route : `POST /api/sessions/{id}/reasoning` (`auto` ou `null` pour revenir au
réglage de Hermes — effectif au message suivant, comme le verrou de modèle du
point 3 et le lien d'agent du point 18). `POST /api/sessions` accepte aussi
`reasoning`, pour que le choix mémorisé s'applique dès la première ligne d'une
nouvelle discussion.

### 35. L'état de la machine vient du dashboard, et coûte 100 ms par lecture

La carte d'accueil propose, depuis toujours, « Quel est l'état du Raspberry Pi
(CPU, RAM, disque) ? » — une question qui coûtait **un tour entier** : le
modèle, un appel `terminal`, l'attente, puis une réponse en prose. Or le
dashboard publie ces nombres : `GET /api/system/stats`
(`hermes_cli/web_server.py`) rend l'OS, l'architecture, le nombre de cœurs,
`cpu_percent`, `load_avg`, `memory`, `disk`, `uptime_seconds` — dans les mots
d'amont, « read-only and non-sensitive (no env values, no paths beyond the
hermes home root) ». Le gateway, lui, n'expose rien de tout ça : sa seule
donnée machine est le contrôle `disk` de `/health/detailed`.

Ce qui a été **mesuré sur ce Pi**, contre l'application construite et les deux
serveurs amont réels :

| | avant | après |
|---|---|---|
| `GET /api/status` | 13 ms | **110 ms** |

Les 100 ms ne sont pas les nôtres : `get_system_stats` appelle
`psutil.cpu_percent(interval=0.1)`, c'est-à-dire qu'il **échantillonne le CPU
pendant un dixième de seconde** dans le handler. C'est le prix d'une mesure
instantanée, et c'est pourquoi cet appel :

- part **en parallèle** des deux autres dans `Promise.allSettled` (le coût est
  un `max`, pas une somme) ;
- n'est **jamais sondé en boucle** — le panneau d'état ne lit qu'à l'ouverture
  et sur « Actualiser », comme il le faisait déjà pour `/health/detailed` ;
- porte 5 s de plafond et **aucun retry** : c'est un agrément sur un panneau de
  diagnostic, il ne doit pas retarder les contrôles de disponibilité si le
  dashboard se fige.

Trois règles dans `src/lib/system.ts` (pur, testé) :

- **Une ligne dont les nombres manquent n'est pas dessinée.** Amont dégrade
  proprement quand `psutil` est absent (`psutil: false`) : il ne reste que la
  charge, lue dans la bibliothèque standard. Afficher 0 % de processeur serait
  présenter une absence de mesure comme une mesure.
- **La charge se lit par cœur.** 3,5 c'est l'oisiveté sur un serveur à seize
  cœurs et une file d'attente sur les quatre de ce Pi : le niveau vient de
  `load_avg[0] / cpu_count`, et la ligne affiche « N % de 4 cœurs ».
- **Le disque est délibérément absent** de cette section : le contrôle `disk`
  du gateway l'affiche déjà six lignes plus haut dans le même panneau, et le
  même nombre deux fois se lit comme deux mesures. Pour la même raison les
  tailles sont en puissances de 1024, comme cette ligne-là — qui passe
  maintenant par la **même** fonction (`formatBytes`, voir les conventions) au
  lieu d'une division maison par 1024³ arrondie au gigaoctet entier, laquelle
  annonçait « 0 Go libres » sur une carte qui avait encore 400 Mo.

Vérifié sur l'application construite, contre les deux amonts : dashboard
joignable → les quatre lignes ; dashboard arrêté → `system: null`,
`systemError` porte « Le dashboard Hermes est injoignable », et les contrôles
de disponibilité restent affichés (82 ms) ; `HERMES_DASHBOARD_TOKEN` vide → la
section dit que le jeton manque, **avec ses mots à elle** : le message partagé
`dashboard_disabled` parle de « la gestion des providers », ce qui est vrai du
panneau pour lequel il a été écrit et trompeur sous un titre qui parle du
Raspberry Pi.

Route : `GET /api/status` (champs `system` et `systemError`).

### 36. La consommation : Hermes la mesure déjà, personne ne la lisait

Une ligne de session porte ses compteurs (`input_tokens`, `api_call_count`,
`estimated_cost_usd`…) et l'entête en affiche le résumé pour la conversation
ouverte. Ce qui manquait, c'est la question posée **sur l'ensemble** : qu'est-ce
que cette semaine a consommé, quel modèle a fait le travail, quels outils
l'agent attrape vraiment. Le gateway ne sait pas répondre — il n'expose aucune
agrégation —, mais le dashboard oui : `GET /api/analytics/usage?days=N`
(`hermes_cli/web_server.py`) somme la table `sessions` et passe par
`InsightsEngine` pour les comptes d'outils et de skills.

**Mesuré sur ce Pi**, dix échantillons par fenêtre, à travers le dashboard :
**8–16 ms** pour 7, 30 et 90 jours (1,1 ko, 2,1 ko, 3,8 ko de réponse). C'est
une lecture de `~/.hermes/state.db`, pas un aller-retour vers un fournisseur :
rien à cacher ici, contrairement au catalogue de modèles (point 26) et
contrairement à `/api/system/stats`, qui échantillonne le CPU pendant 100 ms
(point 35). À travers notre route, bout en bout sur l'application construite :
93 ms au premier appel, **11–18 ms** ensuite.

Trois pièges, tous relevés contre le SQL amont et non supposés :

- **Les journées sont des jours UTC.** La requête groupe sur
  `date(started_at, 'unixepoch')`, sans argument de fuseau. Les relire en heure
  locale décalerait chaque barre de quelques heures et rangerait le travail de
  ce matin sur hier — l'erreur d'un jour que `localDay()` évite dans la sidebar
  (point 24), rencontrée par l'autre bout. La chaîne du seau est donc formatée
  **comme l'étiquette qu'elle est déjà**, jamais convertie en instant.
  `tests/usage.test.ts` rejoue quatre fuseaux, de Kiritimati à Niue.
- **Une journée sans session est absente de la réponse, pas à zéro.** Six
  lignes sont revenues pour une fenêtre de 30 jours sur cette machine :
  dessinées telles qu'elles arrivent, elles se lisent comme six jours
  consécutifs. `dailyBars()` les pose donc sur un axe continu et comble les
  trous. L'axe est borné à `jours + 1` seaux — la coupure amont est
  `now - jours × 86400`, un instant et non un minuit, donc une fenêtre de
  7 jours touche légitimement 8 jours calendaires — ce qui est aussi ce qui
  empêche une date corrompue de demander vingt mille barres.
- **`sessions` compte des sessions Hermes, pas des conversations.** Une
  compression fait basculer une conversation sur une nouvelle ligne de session
  (point 23), et le CLI, Telegram et les tâches planifiées créent les leurs.
  C'est le plan de charge de l'agent entier — la lecture intéressante, à
  condition que le panneau le dise au lieu de laisser croire qu'il a compté la
  sidebar. Il le dit.

Deux honnêtetés de plus, dans `src/lib/usage.ts` (pur, testé) :

- **Un coût à zéro est expliqué, jamais présenté comme « gratuit ».**
  `estimated_cost_usd` vaut 0 aussi bien pour un modèle gratuit que pour un
  modèle dont Hermes n'a jamais connu le tarif — seuls openrouter / nous /
  novita portent un catalogue de prix (point 33). Relevé ici : les neuf
  sessions des 30 derniers jours tournent sur `openrouter/free`, donc le
  panneau affiche `0 $` **et** la phrase qui dit pourquoi.
- **Les zéros d'une ligne de modèle sont retirés.** Les deux arrivent
  vraiment : une ligne de session existe avant son premier appel facturable
  (`0 appels`), et un modèle purement auxiliaire — vision, compression, fondu
  en amont par `_merge_aux_into_by_model` — n'incrémente jamais le compteur de
  sessions (`0 sessions`). Les deux sont apparus sur la fenêtre de 90 jours de
  cette machine, et la ligne se lisait « 0 appels · 1 sessions ».

La route **ne relaie pas** la réponse amont : celle-ci porte des métadonnées de
capacités par modèle, un détail par tâche auxiliaire et des horodatages par
skill que ce panneau ne dessine pas, et relayer une charge utile entière est la
façon dont une route cesse d'avoir un contrat. `normalizeUsage()` **est** le
contrat.

Et `reason` sépare les deux manières d'être éteint, parce que les confondre est
exactement ce que le point 4 du contrat d'erreurs interdit : jeton absent →
`disabled` (le message peut nommer un remède), jeton refusé ou dashboard
redémarré → `failed`, relu à l'ouverture suivante. **Vérifié** sur
l'application construite contre le vrai dashboard : jeton vide → `disabled` ;
jeton bogus → `failed` avec le message du 401 ; dashboard injoignable →
`failed` en 177 ms.

Le panneau est chargé à la demande comme les autres (point 21), n'est
jamais sondé en boucle (lecture à l'ouverture et sur « Actualiser »), et garde
une réponse par fenêtre : revenir sur une période déjà lue ne coûte rien au Pi.

Route : `GET /api/usage?days=7|30|90` (toute autre valeur retombe sur 30 —
amont accepterait 1 à 365, et cette route ne doit pas être le moyen de faire
lire une année de sessions à chaque requête).

### 37. Une mesure de géométrie se paie une fois par image, pas une fois par événement

Deux endroits de l'app lisent une propriété de mise en page puis la réécrivent :
le champ du composeur (`height: auto` → `scrollHeight` → `height`, pour grandir
avec le brouillon) et le fil (`scrollHeight` → `scrollTo`, pour garder une
réponse en cours à l'écran). Ce sont des **recalculs de mise en page forcés** :
la lecture ne peut pas être servie depuis l'image précédente dès que quelque
chose au-dessus a changé, donc le navigateur met tout le document en page sur
place.

Le composeur était branché sur un **événement** et non sur une **image** — un
appel par frappe — alors que le résultat ne s'observe qu'une fois par image.
Une rafale de frappes achetait donc une rafale de mises en page pour rien.

`perFrame()` (`src/lib/client/frame.ts`) est le regroupement : `schedule()` ne
retient qu'une seule exécution par image, `cancel()` la jette au démontage.
`requestAnimationFrame` plutôt qu'un minuteur pour trois raisons, dont aucune
n'est interchangeable :

- Une image est exactement la granularité à laquelle le résultat se voit.
- Le rappel tourne **avant** le style et la mise en page de cette image-là,
  donc l'écriture qu'il fait est peinte dans la même image que l'événement qui
  l'a programmée : le champ grandit avec le caractère qui l'a élargi, sans
  retard visible.
- Un rappel programmé page cachée **reste en attente** et s'exécute au retour.
  Un onglet en arrière-plan ne met donc rien en page, et retombe quand même au
  bon endroit — ce qu'un minuteur perdu ne donne pas.

Le composeur ajoute une seconde moitié : **le même texte n'est pas mesuré deux
fois** (`textarea.value === sizedFor`). C'est ce qui rend gratuite la deuxième
passe du démarrage — une quand le champ se lie, une quand le brouillon de la
conversation ouverte est repris, sans rien entre les deux qui change la réponse.

**Mesuré sur ce Pi 5**, Chromium headless, contre un faux gateway, fil de
20 messages, 200 frappes dans le composeur :

| | avant | après |
|---|---|---|
| lectures forcées de `scrollHeight` | 200 | 43 |
| temps passé dans ces lectures | 88 ms | 27 ms |
| mises en page / recalculs de style | 600 / 601 | 286 / 318 |
| temps de thread principal | 638 ms | 463 ms |

Et le cas qui coûte vraiment ici — taper **pendant** qu'un tour s'écrit à
480 caractères/seconde, donc avec le fil qui grandit sous la boîte — le
défilement du fil garde, lui, ses propres lectures (voir plus bas) :

| | avant | après |
|---|---|---|
| lectures forcées / temps | 254 / 95 ms | 94 / 27 ms |
| mises en page | 608 | 305 |
| temps de thread principal | 702 ms | 530 ms |
| temps réel pour les 200 frappes | 998 ms | 820 ms |

Le démarrage perd une de ses deux passes : le temps de mise en page forcée
attribué à `scrollHeight` sur huit chargements à froid passe de 35 ms à 24 ms —
mais le total du démarrage reste dans la dispersion entre deux exécutions
(240 ms → 235 ms), donc ne pas le compter comme un gain.

**Et le fil, lui, reste délibérément sur un microtask.** C'est la moitié de ce
changement qui a été **essayée, mesurée et annulée**, et ça vaut d'être écrit
pour que personne ne la refasse :

- Le regroupement marchait : sur 60 s de flux à 480 caractères/seconde, les
  7 416 `scrollTo` devenaient 3 600 (un par image) et les 3 923 recalculs de
  style 3 609. Mais **le temps total de thread principal du tour n'a pas
  bougé** — à la cadence réelle d'une réponse, ces lectures tombaient sur une
  mise en page que le navigateur venait de faire de toute façon.
- Et ça **cassait** l'accrochage au bas du fil. Les événements `scroll` sont
  distribués **avant** les rappels d'image : un défilement reporté à l'image
  laisse `onScroll` voir le transcript fraîchement remplacé, en déduire un
  grand écart et dépingler la vue avant que le rappel ne tourne. Mesuré sur ce
  Pi : ouvrir une conversation depuis la sidebar laissait le fil **en haut**
  (écart 6 822 px au lieu de 0), quatre fois de suite, alors que le
  `tick().then()` d'origine donne 0. Le microtask passe avant le navigateur, et
  c'est tout son intérêt.
- Un garde-fou « ignorer un `scroll` pendant qu'une image est en attente »
  ne marche pas non plus : pendant un tour il y a presque toujours une image en
  attente, donc remonter pour relire ne dépinglerait plus rien — exactement le
  comportement que la vue épinglée existe pour éviter.

`tests/frame.test.ts` couvre le regroupement (une rafale → une exécution, une
image → une de plus, un rappel qui se reprogramme n'est pas avalé, `cancel()`
ne bloque pas la suite), relit le composeur (un `queueMicrotask(autosize)`
remis remettrait une mise en page forcée par frappe) **et relit la page** pour
que le défilement du fil reste sur son microtask.

## Événements SSE de `/api/sessions/{id}/chat/stream`

| Événement | Charge utile utile | Traitement UI |
|---|---|---|
| `run.started` | `user_message`, `runtime` | — |
| `message.started` | `message.id` | — |
| `assistant.delta` | `delta` | concaténé dans la bulle |
| `tool.progress` | `tool_name`, `delta` | `_thinking` → bloc raisonnement |
| `tool.started` | `tool_name`, `preview`, `args` | ajoute une étape `running` |
| `tool.completed` / `tool.failed` | `tool_name`, `preview` | clôt la dernière étape `running` du même outil |
| `assistant.completed` | `content` (texte final **autoritaire**), `session_id` | écrase le buffer de deltas |
| `run.completed` | `messages`, `usage`, `runtime`, `session_id` | fin de tour |
| `error` | `message` | bandeau d'erreur |
| `done` | — | ferme le lecteur |

Des commentaires `: keepalive` arrivent toutes les N secondes ; le parseur
(`src/lib/sse.ts`) les ignore. `assistant.completed` est autoritaire parce que
certains contenus (médias résolus en `data:` URL) ne passent pas par les
deltas. Le `session_id` de ces deux trames est le seul **effectif** — toutes
les autres portent l'id demandé, posé par défaut : voir le point 23.

**Ce flux n'est lu qu'à un seul endroit.** Le navigateur
(`chat.svelte.ts#consume()`) et le registre de tours du serveur
(`server/turns.ts::pump()`) tenaient chacun sa copie de la même boucle :
`getReader`, `TextDecoder`, `parseSSEChunk`, puis un `JSON.parse` dans un
`try/catch` qui **saute** une trame illisible au lieu de tuer le tour. C'est
maintenant `readTurnStream()` (`src/lib/sse.ts`), un générateur asynchrone qui
rend, pour chaque morceau reçu, **les octets bruts et les trames qu'ils ont
complétées** — les octets d'abord, parce que le serveur les recopie vers le
navigateur et que l'ordre du fil doit être conservé. Il relâche aussi le
lecteur amont dans son `finally`, ce que le client ne faisait pas quand il
sortait de la boucle sur `done`.

La charge utile d'une trame n'est plus un `Record<string, any>` mais
`StreamEventData` (`src/lib/types.ts`), dont les champs sont ceux que
`_event_payload` et ses appelants construisent dans `api_server.py` (0.20.0) —
`status` et `code` exceptés, qui n'apparaissent que sur une trame `error`
fabriquée par notre propre `sseErrorResponse()`. Rien n'est validé à
l'arrivée : les gardes `typeof` d'`applyTurnFrame()` restent la seule
vérification réelle, et le test qui leur passe un `session_id` numérique le
fait par un cast délibéré.

### Le transcript rechargé, lui, n'a pas la même forme

`groupTranscript()` (`src/lib/transcript.ts`, pur et testé) replie les lignes
persistées — `user → assistant(tool_calls) → tool → … → assistant` — en tours
d'UI, pour qu'un rechargement ressemble à ce que le flux a produit. Deux
constats vérifiés dans les sources de Hermes, qui commandent le pliage :

- **Une ligne `tool` ne porte pas toujours `tool_name`.** Les lignes que Hermes
  synthétise pour un appel refusé (nom d'outil invalide, arguments JSON
  illisibles, `agent/conversation_loop.py`) posent `name` mais pas `tool_name`,
  et `_rows_to_conversation` (`hermes_state.py`) omet la colonne quand elle est
  NULL. Le nom utile vient donc du `tool_calls` de la ligne assistante : la
  fusion des deux lignes par `tool_call_id` **conserve** ce nom, et le générique
  « tool » n'est posé qu'en dernier recours, sur une ligne d'outil orpheline.
- **Les clés d'étapes doivent être uniques dans un tour** : `ToolSteps.svelte`
  rend un `{#each … (step.key)}` clé, et un doublon est une erreur d'exécution,
  pas un défaut d'affichage. D'où la déduplication par `Map` et le `uid()` de
  secours quand une ligne n'a ni `tool_call_id` ni `id`.

Et ces deux lignes ont maintenant un type, comme les trames du flux en ont un
(`StreamEventData`) : `HermesMessage.content` vaut `string | ContentPart[] |
null` — la liste multimodale est ce que la colonne contient vraiment dès qu'une
image est jointe, et la déclarer `string` obligeait chaque test d'une telle
ligne à passer par un `as unknown as string` — et `tool_calls` vaut
`HermesToolCall[]`, la forme OpenAI `{id, type, function:{name, arguments}}`
plus la forme plate `{name, arguments}` que certains fournisseurs émettent.
Rien n'est validé à l'arrivée pour autant : les gardes `typeof` de `textOf()`
et le `Array.isArray()` sur `tool_calls` restent la seule vérification réelle,
parce que ces colonnes sont du JSON que nous n'avons pas écrit.

## Structure

```
src/
├── lib/
│   ├── server/        code jamais envoyé au navigateur
│   │   ├── config.ts    variables d'env + validation au démarrage
│   │   ├── hermes.ts    client de l'API Hermes (Bearer, timeouts, retries)
│   │   ├── dashboard.ts client du dashboard Hermes (jeton, providers, machine)
│   │   ├── cache.ts     lecture amont gardée en mémoire : vol unique,
│   │   │                  stale-while-revalidate
│   │   ├── catalog.ts   modèles, skills et toolsets derrière ce cache
│   │   ├── upstream.ts  socle commun des trois clients amont : UpstreamError,
│   │   │                  retry des lectures
│   │   ├── sse.ts       en-têtes SSE + enveloppe d'erreur
│   │   ├── agents.ts    magasin d'agents, lien conversation → agent, héritage
│   │   │                  de `session_meta` après une compression
│   │   ├── jobs.ts      lien tâche planifiée → agent, prompt composé
│   │   ├── reasoning.ts effort de réflexion d'une conversation, et les
│   │   │                  `model_options` que son prochain tour portera
│   │   ├── search.ts    recherche de passages à travers les conversations
│   │   ├── trash.ts     balayage à échéance + contenu de la corbeille
│   │   ├── turns.ts     registre des tours en vol, présence, notification
│   │   ├── push.ts      envoi Web Push (abonnements, 410 → oubli)
│   │   ├── push-crypto.ts RFC 8291 + RFC 8292, sans dépendance
│   │   ├── db.ts        better-sqlite3 (prefs, prompts, thème, titres, push)
│   │   │                  — la table `agents` vit dans server/agents.ts, et
│   │   │                  c'est ici que les colonnes de `session_meta` naissent
│   │   ├── limits.ts    sémaphore de tours + token bucket
│   │   ├── skills.ts    lecture/écriture des SKILL.md sur le disque
│   │   └── respond.ts   UpstreamError → réponse JSON typée, `gate`, `readJson`
│   ├── client/        helpers navigateur
│   │   ├── api.ts       fetch typé → ApiError, `withRetry`
│   │   ├── storage.ts   localStorage qui ne peut pas jeter, + reprise
│   │   │                  des clés `hermes-*` sous leur nom `yadai-*`
│   │   ├── platform.ts  ⌘ vs Ctrl
│   │   ├── dialog.svelte.ts  focus d'un dialogue : entrée, piège de Tab, retour
│   │   ├── menu.svelte.ts    clavier d'un menu surgissant : Échap, flèches
│   │   ├── frame.ts        une mesure de géométrie par image, pas par frappe
│   │   └── lazy.svelte.ts  composant récupéré à la première utilisation
│   ├── components/    Sidebar, Message, ToolSteps, Composer, ModelPicker,
│   │                  AgentPicker, Markdown, CommandPalette, Icon, Modal (cadre
│   │                  commun des panneaux), StatusPanel, SkillsPanel,
│   │                  ProvidersPanel, JobsPanel, AgentsPanel, SettingsPanel, PushSettings,
│   │                  ThemePanel, UsagePanel, Shortcuts, Toasts
│   ├── stores/
│   │   ├── chat.svelte.ts       tout l'état de conversation (runes Svelte 5)
│   │   ├── agents.svelte.ts     équipe d'agents personnalisés
│   │   ├── skills.svelte.ts     état de l'éditeur de skills
│   │   ├── prompts.svelte.ts    bibliothèque de prompts enregistrés
│   │   ├── providers.svelte.ts  état du panneau providers (dont le flux OAuth)
│   │   ├── jobs.svelte.ts       état du panneau des tâches planifiées
│   │   ├── drafts.svelte.ts     brouillon par conversation (localStorage)
│   │   ├── push.svelte.ts       abonnement Web Push + report de présence
│   │   ├── theme.svelte.ts      palette active + cache d'avant-rendu
│   │   ├── usage.svelte.ts      consommation lue par fenêtre de 7 / 30 / 90 jours
│   │   └── toast.svelte.ts      notifications dans la page
│   ├── attach.ts      fichier texte déposé : tri binaire/texte, bornes, bloc
│   │                  de code inséré dans le message
│   ├── a11y.ts        arrêts de tabulation d'un dialogue (piège de focus),
│   │                  déplacement des flèches dans un menu surgissant,
│   │                  repliage d'un listbox en groupes, et phrase annoncée
│   │                  par la zone live d'un tour
│   ├── availability.ts  l'état d'un panneau optionnel : pas encore lu, prêt,
│   │                  désactivé, illisible — et quand relire
│   ├── drafts.ts      brouillons de composeur : clés, bornes, éviction, et le
│   │                  message rendu quand le tour n'a jamais démarré
│   ├── icons.ts       le jeu d'icônes : tracés 24×24, sans dépendance
│   ├── trash.ts       corbeille : compte à rebours, échéance, lignes à balayer
│   ├── json.ts        décodage d'un corps de réponse qui n'est peut-être pas du JSON
│   ├── agents.ts      agents : bornes, cycles, arbre d'équipe, prompt composé
│   ├── approvals.ts   tour retombé faute d'approbation, + politique d'approbation
│   ├── errors.ts      ApiError + codes + `humanizeError`
│   ├── format.ts      la seule façon dont l'app écrit une quantité : octets,
│   │                  jetons, comptes, dollars, et la virgule décimale
│   ├── jobs.ts        horaires cron validés/traduits/composés, état et tri
│   │                  des tâches, fiche d'agent dans le prompt d'une tâche
│   ├── models.ts      inventaire /api/model/options : provider d'un modèle,
│   │                  lignes du sélecteur, prix par million de jetons
│   ├── prompts.ts     prompts enregistrés : titres, bornes, recherche
│   ├── push.ts        charge utile d'une notification, libellés, capacités
│   ├── reasoning.ts   effort de réflexion : niveaux acceptés par Hermes,
│   │                  libellés, charge utile `model_options` d'un tour
│   ├── search.ts      recherche accent-insensible dans un fil, extraits
│   ├── system.ts      les constantes vitales de la machine : lignes, seuils,
│   │                  tailles et durée d'allumage
│   ├── usage.ts       consommation de l'agent : seaux de jours UTC posés sur un
│   │                  axe continu, parts, et un coût à zéro qui s'explique
│   ├── providers.ts   groupement des clés par provider, statut des comptes,
│   │                  machine à états du flux OAuth
│   ├── sessions.ts    groupement par date, recherche, libellés, usage,
│   │                  candidats de la vue archivée, rotations de compression
│   ├── skills.ts      chemins de skills validés, gabarits, groupement
│   ├── sse.ts         parseur SSE incrémental + lecture d'un tour (partagés)
│   ├── text.ts        repli d'accents, correspondance, troncature, slug —
│   │                  la seule définition de « ça correspond »
│   ├── theme.ts       préréglages, dérivation color-mix, contraste WCAG, refus
│   │                  d'écrire un thème composé sur une ligne non lue
│   ├── turns.ts       résumé d'un tour + « faut-il notifier ? »
│   ├── markdown.ts    rendu tolérant à l'incomplet, et la part d'un message
│   │                  en cours qui ne sera plus re-parsée
│   └── transcript.ts  regroupement du transcript persisté en tours UI
├── hooks.server.ts    contrôle d'origine à l'exécution + en-têtes de sécurité
├── routes/
│   ├── +page.svelte   l'écran de chat (`?s=<id>` ouvre une conversation)
│   ├── api/**         proxy authentifié
│   └── health/        sonde du healthcheck Docker
└── service-worker.ts  cache de l'app shell (jamais /api) + handlers push
```

## Gestion des erreurs — le contrat

Une seule règle : **rien n'échoue en silence, et chaque message dit quoi
faire**. Trois couches, chacune avec son rôle.

**0. `lib/server/upstream.ts`** — ce que les trois clients amont ont en
commun. Le gateway (`hermes.ts`), le dashboard (`dashboard.ts`) et le
répertoire de skills (`skills.ts`) sont trois choses sans rapport, mais une
route traite leurs échecs à l'identique : un statut, un code, un message déjà
écrit pour un humain. D'où `UpstreamError`, dont `HermesError`,
`DashboardError` et `SkillsFsError` héritent — les sous-classes ne servent plus
qu'à dire *lequel* des trois a échoué (`err instanceof HermesError`). Trois
conséquences à connaître :

- **Un seul ordre d'arguments** : `(status, message, code)`. `SkillsFsError`
  prenait `(status, code, message)`, et intervertir deux chaînes ne se voit ni
  à la compilation ni à l'exécution — ça livre juste un code là où
  l'utilisateur devait lire une phrase. `tests/upstream.test.ts` relit la
  source pour que l'ancien ordre ne revienne pas.
- **Une seule définition de « ça vaut la peine de réessayer »** :
  `status >= 500`, et rien d'autre. Les codes que les clients forgent
  eux-mêmes (timeout, injoignable) portent déjà 504 et 502 ; un 429 n'est pas
  transitoire — se faire dire de ralentir n'est pas une raison de refrapper.
- **Une seule boucle de retry**, `retrying()`, opt-in à chaque appel.

**1. `lib/server/hermes.ts`** — timeout par appel (`REQUEST_TIMEOUT_MS`, 30 s ;
les flux SSE passent `timeoutMs: 0` car un tour d'agent dure légitimement des
minutes), et `retries` **uniquement sur les lectures**. Rejouer un POST qui a
créé une session ou lancé un tour dupliquerait le travail — ne jamais mettre
`retries` sur `createSession`, `forkSession` ou un stream.

**2. `lib/server/respond.ts` + `limits.ts`** — `proxy()` traduit une
`UpstreamError` en JSON `{error:{message,code,retry_after}}` avec le statut
amont. Son second argument est le repli quand l'exception n'en est pas une :
`dashboardResponse()` et `skillsJson()` ne sont plus que `proxy()` avec ce
repli lié. `gate()` applique un token bucket par classe de route. Le sémaphore de
`MAX_CONCURRENT_TURNS` (3 par défaut) refuse un 4ᵉ tour **avant** Hermes : le
cap amont est de 10, mais un Pi 5 rame bien avant, surtout si plusieurs agents
lancent Chromium.

**3. `lib/errors.ts`** — `humanizeError()` transforme un code en phrase
actionnable. « Too many concurrent runs (max 10) » ne dit rien à l'utilisateur ;
« Hermes exécute déjà le maximum de tours simultanés » si. Ajouter un cas ici
plutôt que d'afficher le texte amont brut.

**4. `lib/availability.ts`** — « je n'ai pas pu lire » n'est pas
« c'est désactivé ». Trois panneaux se tiennent devant quelque chose de
facultatif — l'éditeur de skills et son bind mount (point 11), les providers et
leur jeton de dashboard (point 13), les tâches et le module cron (point 14) —
et chacun a donc un écran « c'est éteint, voici pourquoi ». Le texte de ces
écrans **est un remède** : « ajoutez le volume `/skills` et relancez
`docker compose up -d` ». Les trois y faisaient tomber n'importe quel échec de
lecture.

**Mesuré sur ce Pi**, contre l'application qui tourne : `GET /api/skills/files`
répond `429 rate_limit_exceeded` au-delà de douze appels rapprochés (le
garde-fou de `gate()`) et `500` sur une erreur de système de fichiers
(`EACCES: permission denied, scandir`) ; et le navigateur forge le sien —
`Connexion perdue.` — dès qu'un téléphone quitte le tailnet. Les trois
affichaient le paragraphe sur `docker-compose.yml`, avec aplomb, à propos d'un
répertoire monté tout du long. Pire, l'état **collait** : le `$effect`
d'ouverture ne relisait que tant que la disponibilité était inconnue, donc une
coupure d'une seconde désactivait l'éditeur jusqu'au rechargement de la page.

`panelState()` rend donc `unread | ready | disabled | failed`, où `failed`
**l'emporte sur `disabled`** (une lecture qu'on n'a pas pu faire ne dit rien de
la configuration), et `shouldLoadPanel()` relit à l'ouverture suivante dans ce
seul cas. Le panneau montre le vrai message, un bouton « Réessayer », et une
phrase qui dit que le montage est peut-être parfaitement sain.

Deux détails à ne pas défaire :

- **La lecture de l'état est `untrack()`ée dans le `$effect`.** `failed` est un
  état qui *demande* à être rechargé : un effet qui se réexécuterait à chaque
  mutation du store appellerait `refresh()`, verrait l'échec arriver, et
  rappellerait — en boucle serrée sur l'endpoint qui vient de tomber. `open`
  doit rester la seule dépendance.
- Dans `JobsPanel`, le bloc d'échec se pose **au-dessus** de la liste et non à
  sa place : un rafraîchissement raté après une action ne doit pas faire
  disparaître les tâches de l'écran. Et « Aucune tâche planifiée » n'est plus
  écrit sur une liste jamais reçue — c'est le panneau où le croire veut dire
  planifier deux fois la même tâche.

Points de détail qui comptent :

- **Les erreurs de streaming voyagent en SSE, pas en HTTP.** Le client lit
  `/api/sessions/{id}/stream` avec un stream reader : un corps JSON d'erreur
  lui apparaîtrait comme un flux tronqué. `sseErrorResponse()` émet donc
  `event: error` + `event: done`, avec `status` et `code` dans la charge utile.
- **Un flux qui s'arrête n'est pas un flux qui se termine.** Un corps SSE
  coupé en plein tour ne lève rien : le lecteur voit une fin de flux normale.
  Vérifié avec un serveur local qui coupe après deux frames — aucune exception,
  aucune erreur, la réponse partielle s'affichait comme une réponse finie.
  `#consume()` exige donc un événement terminal (`isTerminalTurnEvent` :
  `done`, `error`, `run.completed`, `assistant.completed`) ; sans lui le tour
  est marqué `detached: 'truncated'`, ce qui affiche « ce texte est incomplet »
  et un bouton « Recharger », puisque l'agent continue en arrière-plan comme
  après un détachement. Le côté Hermes qui produit ce cas est le `except
  Exception` de la boucle d'écriture SSE (`api_server.py`) : la boucle sort et
  rend la réponse proprement, alors que le `done` posé dans la file par le
  `finally` de la tâche n'est plus écrit sur le fil.
- **404 sur une session = re-synchroniser.** Une conversation peut être
  supprimée depuis le CLI, Telegram ou un autre onglet. `openSession` retire la
  ligne fantôme de la sidebar au lieu d'afficher une erreur.
- **Le sondage de santé se ré-accélère quand ça casse** (3 s → 30 s en backoff,
  60 s quand tout va bien) et déclenche un `refreshSessions()` au retour :
  l'état a pu bouger pendant qu'on était aveugle.
- **Le titre est UNIQUE dans le schéma Hermes.** Deux discussions ouvertes par
  le même prompt collisionnent (`invalid_title`, insertion annulée). La route
  `POST /api/sessions` retente sans titre plutôt que de refuser la
  conversation.
- **Le filet de sécurité global** est dans `+layout.svelte`
  (`error` / `unhandledrejection`) : sans lui, une exception dans un effet
  fige l'UI sans un mot. Les `AbortError` y sont ignorés — ce sont des
  annulations voulues.

## Conventions

- **Svelte 5 runes** (`$state`, `$derived`, `$effect`) — pas de stores
  `writable`. Après un `push` dans un tableau `$state`, relire l'élément depuis
  le tableau : seules les mutations à travers le proxy sont réactives.
- **`ssr = false`** (`src/routes/+layout.ts`) : app privée, aucun SEO, et pas
  de rendu serveur à payer sur un Pi.
- **Aucun appel direct à Hermes depuis un composant** — tout passe par
  `/api/*`.
- Interface en **français**.
- Les tests (`tests/*.test.ts`) tournent sous `node --test` avec le
  type-stripping natif : ils importent les sources par leur chemin `.ts`, sans
  étape de build. N'y mettez que de la logique pure (pas de DOM) — c'est
  pourquoi `renderMarkdown` n'est pas testé directement, seulement
  `closeOpenConstructs` et la sortie de `marked`.
- **Un import de valeur d'un module de `src/lib` vers un autre porte son
  extension `.ts`** (`from './text.ts'`). Le type-stripping de Node ne devine
  pas l'extension : sans elle, `npm run check` et `npm run build` passent —
  Vite, lui, la devine — et `npm test` échoue en `ERR_MODULE_NOT_FOUND` sur
  chaque fichier de test qui traverse ce module. `tsconfig.json` porte déjà
  `allowImportingTsExtensions`.
- **Une seule règle de correspondance**, dans `src/lib/text.ts` :
  `foldAccents()` (minuscules, puis marques diacritiques retirées),
  `searchNeedle()` pour ce qu'un champ de recherche cherche vraiment (replié et
  débarrassé des espaces d'une requête à moitié tapée) et `includesFolded()`
  pour le test lui-même. Les six champs de recherche de l'app y passent —
  sidebar, palette (actions, conversations, passages), prompts enregistrés,
  sélecteur de modèle, providers, skills. Ils avaient divergé : quatre
  comparaient du texte en minuscules tel quel, deux repliaient les accents, et
  les deux règles cohabitaient dans **la même** boîte de recherche — taper
  « modele » dans la palette trouvait la conversation et le passage, jamais
  l'action « Modèle » posée juste au-dessus. `clip()`, `oneLine()` et
  `slugify()` sont là pour la même raison : ils existaient en double.
- **Une seule façon d'écrire une quantité**, dans `src/lib/format.ts` :
  `formatBytes()`, `formatTokens()`, `formatCount()`, `formatCost()`,
  `formatNumber()`, et le `comma()` privé qui décide seul qu'une décimale
  s'écrit avec une virgule. Les trois quantités de l'app étaient rendues **deux
  fois chacune**, selon l'écran : l'entête écrivait `6.1k ↓ / 4.5k ↑ ·
  $0.0123` quand le panneau Consommation écrivait `6,1 k` et `0,0123 $` des
  mêmes nombres, et l'éditeur de skills `2.0 Ko` là où l'état de la machine
  disait `2 ko` — un point décimal dans une interface par ailleurs
  entièrement en français. Les moitiés perdantes étaient aussi les plus
  courtes : `fmtTokens` n'avait pas de million (1,5 M s'affichait `1500.0k`)
  et celle des skills pas de mégaoctet (un fichier de 5 Mo déposé dans le
  composeur était refusé en annonçant `5120.0 Ko`). `tests/format.test.ts`
  relit `src/lib/**` pour qu'aucun module ne redéfinisse l'un de ces cinq noms
  ni ne décide de son côté que le séparateur décimal est une virgule.
- Thème piloté par des tokens CSS. Les littéraux d'`src/app.css` ne sont que
  le rendu d'avant hydratation ; la source est `src/lib/theme.ts`, appliquée
  en propriétés inline sur `<html>` avec `data-theme` pour le mode. Toute
  nouvelle couleur passe par un token, jamais par un littéral dans un
  composant — voir le point 19.

## Commandes

```bash
npm run dev          # dev sur 127.0.0.1:5173 (lit .env)
npm run build        # sortie dans build/
npm run check        # svelte-check — doit rester à 0 erreur
npm test             # node --test sur tests/ (parseur SSE, markdown, transcript)
npm start            # sert build/ avec node

./scripts/smoke.sh   # chaîne complète, y compris le test bloquant du streaming
./scripts/tailscale-serve.sh
./scripts/backup.sh

docker compose up -d --build
docker compose logs -f
```

Journaux Hermes : `journalctl --user -u hermes-gateway -f` et
`~/.hermes/logs/gateway.log`. Pour le dashboard (panneau Providers) :
`journalctl --user -u hermes-dashboard -f`.

## Si tu lis ceci depuis l'exécution automatique de 05:00

Un timer systemd (`hermes-ui-improve.timer`) lance Claude Code chaque jour dans
un **clone isolé** du dépôt, sous `/opt/stacks/hermes-ui-bot/work/`. Tu n'es
pas dans le déploiement.

- Le déploiement en production est `/opt/stacks/Hermes-Ui` : **ne le touche
  pas directement**. C'est le script du runner qui déploiera ton commit
  (fast-forward + rebuild Docker + smoke test avec retour arrière).
- **Ton travail part en production cette nuit, sans relecture humaine
  préalable.** L'utilisateur le découvre au réveil. Sois conservateur : un
  changement sûr et fini vaut mieux qu'un changement ambitieux et fragile.
- Le runner (`/opt/stacks/hermes-ui-bot/`) ne fait pas partie du dépôt et ne
  doit pas être modifié.
- `git log --oneline -15` te dit ce que les exécutions précédentes ont fait :
  ne recommence pas la même chose.
- La source de vérité sur l'API Hermes est
  `/mnt/data/hermes/hermes-agent/gateway/platforms/api_server.py`, en lecture
  seule. La documentation en ligne est en retard sur cette version (0.20.0).

Les consignes complètes sont dans `/opt/stacks/hermes-ui-bot/prompt.md`.

## Sécurité — non négociable

- Le serveur API exécute **le toolset complet, terminal compris, sur le Pi**.
  `API_SERVER_KEY` est un secret équivalent-root.
- `API_SERVER_HOST=127.0.0.1` — ne jamais binder 8642 ailleurs. Idem pour le
  dashboard sur 9119 : `HERMES_DASHBOARD_TOKEN` ouvre l'écriture de
  `~/.hermes/.env` et de `config.yaml`, c'est un second secret du même ordre.
  Il reste côté serveur, comme `HERMES_API_KEY`.
- Le conteneur ne publie que sur `127.0.0.1:3000`. L'exposition passe par
  Tailscale Serve, pas par une redirection de port sur la box.
- Ne pas activer `API_SERVER_CORS_ORIGINS` : le navigateur n'a aucune raison
  de joindre Hermes directement, et l'activer signifierait exposer la clé.
- Pas d'auth applicative : l'identité est garantie par le tailnet. Ne pas
  bricoler un mot de passe maison.
- `VAPID_PRIVATE_KEY` est une clé de signature : elle reste côté serveur, n'est
  jamais journalisée et ne doit jamais entrer dans le dépôt. `VAPID_PUBLIC_KEY`,
  elle, **doit** être servie au navigateur — c'est son rôle. Les endpoints
  d'abonnement sont eux aussi des secrets porteurs : l'UI ne voit qu'un condensé.
