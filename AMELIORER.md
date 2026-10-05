# Améliorer Yadai à la main

Cette procédure est l'équivalent manuel de la routine nocturne
(`/opt/stacks/hermes-ui-bot/improve.sh`, tous les jours à 05:00). Elle existe
pour qu'une amélioration reste possible **sans** lancer la routine et sans le
contexte de la conversation où tout ça a été construit.

Suis les étapes dans l'ordre. Elles sont dans cet ordre pour une raison :
sauvegarder avant de casser, vérifier avant de déployer, déployer avant de
pousser — pour que `main` sur GitHub reflète toujours ce qui tourne vraiment.

---

## 0. Avant de toucher quoi que ce soit

**Lis `CLAUDE.md` en entier.** Il documente le contrat exact de l'API Hermes et
une dizaine de pièges établis par la mesure, pas par la documentation. Ne les
contredis pas sans avoir refait la mesure toi-même.

**Lis `git log --oneline -15`.** Chaque exécution précédente y a laissé une
trace. Ne refais pas ce qui est déjà fait.

Le repère : **la source de vérité sur l'API Hermes est le code**, dans
`/mnt/data/hermes/hermes-agent/` — en particulier
`gateway/platforms/api_server.py` (le serveur API sur `127.0.0.1:8642`) et
`hermes_cli/web_server.py` (le dashboard sur `127.0.0.1:9119`, que cette app
proxifie déjà). La documentation en ligne est en retard sur la version
installée. **Lecture seule** : ne modifie jamais ce dépôt.

### Où est quoi

| Chemin | Rôle |
|---|---|
| `/opt/stacks/Hermes-Ui` | le dépôt **et** le déploiement en production (le répertoire garde son ancien nom : le runner, les sauvegardes et les unités systemd le désignent) |
| `/opt/stacks/hermes-ui-bot` | la routine nocturne — hors dépôt, n'y touche pas |
| `/opt/stacks/hermes-ui-bot/bot.env` | secrets, dont l'URL du webhook Discord |
| `/mnt/data/backups/hermes-ui/` | les sauvegardes horodatées |
| `~/.hermes/` | l'état de Hermes : `state.db`, `skills/`, `config.yaml`, `.env` |

Trois services systemd **utilisateur** : `hermes-gateway` (l'agent),
`hermes-dashboard` (loopback 9119), `hermes-ui-improve.timer` (la routine).

### Règles non négociables

- Ne touche jamais à `.env`, `data/`, `~/.hermes/`, ni à
  `/opt/stacks/hermes-ui-bot/`.
- **N'invente aucune capacité de l'API Hermes.** Si tu supposes qu'un endpoint,
  un événement SSE ou un champ existe, vérifie-le dans le code Python. Sinon,
  ne t'appuie pas dessus.
- Pas de nouvelle dépendance npm sans raison forte : ça tourne sur un
  Raspberry Pi 5 partagé avec d'autres services.
- Aucun secret dans le dépôt, jamais.
- L'interface est en **français** ; le code et les commentaires en **anglais**,
  comme l'existant.
- Les tests tournent sous le type-stripping natif de Node : **pas de
  `const enum`**, **pas de propriétés de paramètres de constructeur**.

---

## 1. Sauvegarder

```bash
STAMP=$(date +%Y%m%d_%H%M%S)
tar -czf /mnt/data/backups/hermes-ui/hermes-ui-${STAMP}.tar.gz \
  --exclude=node_modules --exclude=.svelte-kit --exclude=build \
  -C /opt/stacks Hermes-Ui
chmod 600 /mnt/data/backups/hermes-ui/hermes-ui-${STAMP}.tar.gz
```

`chmod 600` parce que l'archive contient `.env`, donc `API_SERVER_KEY`.

Note le SHA de départ, tu en auras besoin pour revenir en arrière :

```bash
PREV_SHA=$(git -C /opt/stacks/Hermes-Ui rev-parse HEAD)
```

---

## 2. Choisir l'amélioration

Si l'utilisateur a demandé quelque chose de précis, fais ça. Sinon, prends le
thème du jour — la rotation évite que les exécutions convergent vers le même
type de changement :

| Jour | Thème |
|---|---|
| Lundi | Robustesse et gestion d'erreurs |
| Mardi | Nouvelle fonctionnalité |
| Mercredi | Performance sur Raspberry Pi |
| Jeudi | Qualité et simplification |
| Vendredi | Accessibilité et ergonomie mobile |
| Samedi | Couverture de tests |
| Dimanche | Intégration Hermes (relecture de l'API réelle) |

**Une seule amélioration cohérente.** Un diff qu'un humain relit en dix minutes
vaut mieux qu'une refonte. Si le thème n'a rien d'utile à offrir aujourd'hui,
dis-le et choisis un autre axe : ne rien livrer est un résultat acceptable,
livrer du remplissage ne l'est pas.

Sois conservateur : **ce que tu écris part en production à la fin de cette
procédure**, sans relecture préalable.

---

## 3. Implémenter

```bash
cd /opt/stacks/Hermes-Ui
npm ci   # seulement si node_modules manque ou si package-lock.json a changé
```

Ajoute des tests dans `tests/` pour toute logique pure que tu introduis. Si ton
changement modifie un comportement observable, mets à jour `CLAUDE.md` et/ou
`README.md` dans le même commit.

---

## 4. Vérifier — obligatoire

Les trois doivent passer. Si l'une échoue et que tu ne sais pas la réparer,
**annule tes modifications** (`git checkout -- .`) et explique-le, plutôt que
de déployer du code cassé.

```bash
cd /opt/stacks/Hermes-Ui
HERMES_API_KEY=build-placeholder npm run check   # 0 erreur, 0 warning
npm test                                          # tous verts
HERMES_API_KEY=build-placeholder \
  HERMES_PUBLIC_ORIGIN=https://placeholder.invalid npm run build
```

---

## 5. Commiter et déployer localement

```bash
cd /opt/stacks/Hermes-Ui
git add -A
git commit -m "<ce que ça change, et pourquoi>"
docker compose up -d --build
sleep 15
BASE=http://127.0.0.1:3000 ./scripts/smoke.sh
```

`smoke.sh` est bloquant : son test de streaming échoue si les tokens n'arrivent
pas en trames SSE séparées.

**Si le smoke test échoue, reviens en arrière immédiatement** :

```bash
git -C /opt/stacks/Hermes-Ui reset --hard $PREV_SHA
docker compose -f /opt/stacks/Hermes-Ui/docker-compose.yml up -d --build
```

Et ne pousse rien.

---

## 6. Pousser sur GitHub

Seulement une fois le déploiement vérifié — `main` doit refléter ce qui tourne,
jamais l'inverse.

```bash
git -C /opt/stacks/Hermes-Ui push origin main
```

---

## 7. Capture d'écran

Prise sur l'application **déployée**, pour que ce qui part sur Discord soit ce
qui tourne réellement.

```bash
/mnt/data/hermes/hermes-agent/venv/bin/python \
  /opt/stacks/hermes-ui-bot/shot.py \
  "http://127.0.0.1:3000/" /tmp/shot.png "<javascript optionnel>"
```

Le python du venv Hermes est utilisé parce qu'il a `websockets`, nécessaire au
pilotage de Chromium par CDP. Le troisième argument est du JavaScript évalué
dans la page (`awaitPromise: true`) pour amener **ta** modification à l'écran —
ouvrir le bon panneau, cliquer le bon bouton. Environ 6 s s'écoulent avant, et
2,5 s après.

Exemple, pour ouvrir un panneau depuis la sidebar :

```js
(async()=>{const w=m=>new Promise(r=>setTimeout(r,m));
const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Skills'));
if(b)b.click();await w(2000);return 'ok'})()
```

Mets aussi à jour `.bot/screenshot.json` (`path`, `js`, `caption`) : c'est ce
fichier que la routine nocturne relit, et il doit décrire ta modification, pas
celle de la veille.

---

## 8. Prévenir sur Discord

```bash
. /opt/stacks/hermes-ui-bot/bot.env   # fournit DISCORD_WEBHOOK_URL
```

Construis la charge utile en **Python**, jamais par concaténation de chaînes :
un résumé contenant une apostrophe ou un retour à la ligne corromprait le JSON.

```bash
PAYLOAD=$(TITLE="Amélioration déployée" DESC="<ton résumé>" python3 <<'PY'
import json, os
print(json.dumps({"username":"Yadai bot","embeds":[{
    "title": os.environ["TITLE"][:256],
    "description": os.environ["DESC"][:3500],
    "color": 6076508,
    "image": {"url": "attachment://screenshot.png"},
}]}))
PY
)
curl -sS -m 60 \
  --form-string "payload_json=${PAYLOAD}" \
  -F "files[0]=@/tmp/shot.png;type=image/png;filename=screenshot.png" \
  "$DISCORD_WEBHOOK_URL"
```

**`--form-string`, pas `-F`, pour la charge utile.** `curl -F` interprète les
`;` d'une valeur comme le début d'un modificateur de champ (`;type=`,
`;filename=`) : le premier point-virgule du résumé tronque le JSON et Discord
répond `400 Expected "payload_json" to be a valid JSON string`. Ça a coûté une
notification perdue avant d'être compris.

Succès : **200** en multipart (avec image), **204** sans image.

Le message doit contenir, en français : ce que tu as changé, pourquoi, ce que
ça apporte concrètement, ce que le relecteur doit surveiller, le lien du commit
(`https://github.com/S2K7x/Yadai/commit/<sha>`) et la commande de retour
arrière avec le SHA précédent.

---

## Ce qui existe déjà — ne le refais pas

Renommage du produit en **Yadai** (le moteur reste Hermes — voir CLAUDE.md,
« Deux noms ») · seize palettes dont douze relevées d'une étude d'affiches ·
chat en streaming avec timeline des outils · sidebar groupée par date, épinglage,
archivage, branches · palette de commandes `⌘K` · panneau d'état · éditeur de
skills · vue des conversations archivées · panneau providers (clés API + OAuth)
· tâches planifiées · bibliothèque de prompts · export markdown · PWA mobile.

`git log --oneline -15` fait foi, cette liste vieillit.

---

## En cas de doute

Mieux vaut ne rien livrer qu'une modification que tu n'as pas pu vérifier. Dis
ce que tu as constaté, ce qui t'a bloqué, et arrête-toi là. Une PR vide est un
résultat ; une PR qui casse la production à 5 h du matin n'en est pas un.
