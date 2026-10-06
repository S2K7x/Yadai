# Yadai

Interface web privée « type Claude.ai » pour [Hermes Agent](https://hermes-agent.nousresearch.com),
conçue pour tourner sur un Raspberry Pi 5 et remplacer le bot Telegram sans
rien perdre : outils, MCP, mémoire, skills, vision, multi-tours.

**Yadai**, c'est le nom du produit — ce que vous ouvrez, ce que dit l'onglet,
l'icône sur l'écran d'accueil. **Hermes Agent** reste le nom du moteur qu'il
pilote : le dépôt à part sur cette machine, le gateway `127.0.0.1:8642`, les
services `hermes-gateway` / `hermes-dashboard`, `~/.hermes/` et les variables
`HERMES_*`. Là où ce fichier écrit « Hermes », il parle de ce moteur, et jamais
de l'application.

<p align="center">
  <em>SvelteKit · SQLite · SSE · PWA · Tailscale Serve</em>
</p>

## Ce que ça fait

- **Fil de conversation** avec streaming token par token et curseur de frappe
- **Sidebar d'historique** groupée par date (Aujourd'hui / Hier / 7 jours / …),
  épinglage, renommage, archivage, suppression, branches, repli sur desktop
- **Réglages en un seul endroit** : le pied de la sidebar ne porte plus une
  grille de boutons mais une porte, derrière laquelle tout est rangé en trois
  familles — conversations, agent, application
- **Icônes dessinées, pas d'emoji** : une quarantaine de tracés sur une grille
  24×24, en `currentColor`, donc à la couleur du contrôle et de la palette
  active. Un emoji est une police : chaque plateforme dessine le sien, dans des
  couleurs sur lesquelles le thème n'a pas la main
- **Corbeille** : supprimer une conversation ne la détruit plus. Elle attend
  30 jours, avec le compte à rebours affiché, et se restaure exactement où elle
  était — rien n'a été effacé chez Hermes entre-temps, c'est ce qui rend la
  restauration fidèle. Un « Annuler » dans le toast rattrape le geste dans la
  seconde ; « Supprimer définitivement » est la seule action irréversible, et
  la seule qui demande confirmation
- **Vue « Archivées »** reconstruite à la demande : l'API du gateway exclut les
  conversations archivées de toutes ses listes, l'app les retrouve une par une
  à partir des identifiants qu'elle a déjà vus
- **Palette de commandes** `⌘K` (bouton ⌕ dans l'entête) : recherche
  insensible aux accents sur les titres des conversations + actions rapides
- **Recherche dans la conversation ouverte**, dans cette même palette : à
  partir de deux caractères, elle liste les messages du fil qui contiennent ce
  qu'on tape, avec un extrait où le passage trouvé est surligné ; le choisir
  fait défiler le fil jusqu'à ce message et le souligne un instant. C'est la
  seule façon de retrouver un passage sur téléphone, où une PWA installée n'a
  pas de « rechercher dans la page »
- **Recherche dans les *autres* conversations**, dans la même palette :
  « Chercher « … » dans les autres conversations » (ou `⌘↵`) lit les
  transcripts côté serveur — Hermes n'a aucune route de recherche — et rend
  les passages trouvés, avec le nom de leur conversation. Le choisir ouvre
  cette conversation **et** défile jusqu'au message. Explicite et jamais
  déclenchée à la frappe : c'est une lecture amont par conversation, bornée
  aux 40 plus récemment actives
- **Timeline des étapes de l'agent** : chaque appel d'outil (terminal, web,
  navigateur, MCP…) affiché en direct, repliable
- **Panneau d'état** `⌘/` : contrôles de disponibilité (base, modèle,
  disque, gateway, plateformes), outils/skills exposés, tâches planifiées,
  tours en cours, coût et tokens de la conversation
- **L'état du Raspberry Pi**, dans ce même panneau : processeur, charge
  rapportée au nombre de cœurs, mémoire et durée d'allumage — la question que
  la page d'accueil suggérait de poser à l'agent, qui coûtait un tour entier et
  un appel `terminal` pour quatre nombres que le dashboard de Hermes Agent
  publie déjà. Lu à l'ouverture du panneau seulement, jamais en boucle
- **Palette de skills** : `/` dans le composeur
- **Prompts enregistrés** (🔖 dans le composeur, ou `⌘K` → « Prompt : … ») :
  enregistrer le message en cours pour le réutiliser d'un tap ; la
  bibliothèque est stockée côté serveur, donc la même sur le téléphone et sur
  le desktop
- **Équipe d'agents** (👥 dans la sidebar, ou `⌘K` → « Équipe d'agents ») :
  des personas ayant chacune son nom, son métier et son prompt système ; une
  conversation appartient à un agent, et un « chef d'équipe » peut confier du
  travail aux autres via la délégation native de Hermes Agent
- **Éditeur de skills** (Réglages → « Skills », ou `⌘K` → « Modifier les skills ») :
  liste des `SKILL.md` groupée par catégorie, édition en texte brut,
  création guidée d'un nouveau skill
- **Panneau Providers** (Réglages → « Providers », ou `⌘K` → « Providers ») : ajouter
  ou remplacer une clé d'API avec vérification en ligne, connecter un compte en
  OAuth (code d'appairage + sondage jusqu'à validation), déconnecter, et
  changer le modèle par défaut — sans SSH
- **Tâches planifiées** (Réglages → « Tâches planifiées », ou `⌘K`) :
  confier à l'un de vos agents une tâche récurrente que Yadai exécute seul —
  horaire choisi dans des menus plutôt qu'écrit en cron, puis modifiable,
  duplicable, lançable tout de suite, en pause ou supprimée
- **Consommation** (Réglages → « Consommation », ou `⌘K` → « Consommation ») :
  tokens envoyés et produits, coût estimé, modèles, outils les plus appelés et
  skills chargés, sur 7, 30 ou 90 jours, avec une barre par jour. Les chiffres
  sont ceux que Hermes Agent mesure déjà dans sa base de sessions — ils
  couvrent donc **tout** ce que l'agent a fait, cette interface comme le CLI,
  Telegram et les tâches planifiées. Un coût à zéro est expliqué (modèle
  gratuit, ou tarif inconnu de Hermes) plutôt qu'annoncé comme gratuit, et les
  journées sont celles d'amont : découpées en UTC
- **Notifications push** (panneau d'état → « Notifications ») : quand un tour se
  termine alors que l'app n'est pas à l'écran, la réponse arrive sur l'iPhone ou
  le desktop, et un tap ouvre la bonne conversation
- **Brouillons par conversation** : un message commencé et pas envoyé reste sur
  sa conversation — il ne suit plus au changement de fil, et il est toujours là
  après un rechargement ou une PWA relancée par iOS. La sidebar marque d'un ✎
  les conversations qui en portent un
- **Images en entrée** : coller ou déposer, envoyées en base64
- **Fichiers texte en entrée** : déposer, coller ou choisir un `.log`, un
  `.yaml`, un `Dockerfile` ou n'importe quel fichier texte l'insère dans le
  message en bloc de code, avec son nom et le bon langage. L'API de Hermes
  Agent n'accepte que les images en pièce jointe — le prompt, lui, a toujours
  accepté ça, et c'est exactement ce qu'on faisait à la main. Un binaire est
  refusé sur son contenu, et rien n'est jamais tronqué en silence
- **Sélecteur de modèle** parmi les fournisseurs configurés,
  applicable à la conversation ouverte dès le message suivant. Chaque ligne
  affiche ce que le modèle coûte par million de jetons — le catalogue de
  Hermes le dit déjà pour OpenRouter, Nous et Novita — et signale les modèles
  gratuits. Le filtre porte aussi sur le nom du fournisseur, et la liste dit
  combien d'entrées son plafond a laissées de côté au lieu de les faire
  disparaître
- **Effort de réflexion**, dans ce même menu : `Auto` laisse Hermes Agent
  décider selon sa propre configuration, et les six autres niveaux — de `Aucun`
  à `Max` — s'appliquent à la conversation ouverte dès le message suivant. C'est
  le levier que l'API de Hermes accepte sur chaque tour (`model_options`) et le
  même que le `/reasoning` du CLI ; le dernier choix devient le défaut des
  nouvelles discussions. `Aucun` est le plus rapide, `Max` le plus lent et le
  plus cher
- **Export markdown** de la conversation
- **Démarrage rapide** : l'app n'attend plus l'inventaire des modèles pour
  afficher la conversation. Cet appel-là reconstruit le catalogue des
  fournisseurs derrière un cache d'une heure — mesuré à 134 ms à chaud mais
  1,9 s juste après expiration —, il part maintenant en arrière-plan. Du
  premier appel au transcript affiché : 181 ms → 52 ms
- **Blocs de code colorés**, avec un bouton « copier » au survol. Les grammaires
  (37 langages, 164 Ko) ne sont chargées qu'à la première apparition d'un bloc
  de code, pas au démarrage de l'app
- **Design** : des cartes qui flottent sur un fond creusé, séparées par leur
  élévation et jamais par un trait — trois niveaux d'ombre, teintés avec la
  couleur de la palette active. Carte d'accueil en dégradé, pastilles rondes en
  tête de chaque ligne de liste, composeur détaché du bas avec un bouton
  d'envoi circulaire
- **Apparence** (◐ dans l'entête, ou `⌘K` → « Apparence ») : seize palettes
  nommées, mode clair / sombre, et deux couleurs d'accent choisissables — le
  reste en est dérivé. Douze d'entre elles viennent d'une étude d'affiches,
  relevées au pixel : Corail, Crème, Pinède, Lagune, Brume, Abricot,
  Framboise, Menthe, Ambre, Dragée, Brique, Outremer. Chacune est vérifiée par
  les tests — texte à 4,5:1 sur sa propre surface, anneau de focus à 3:1 sur
  les trois fonds. Le choix est enregistré côté serveur, donc le téléphone
  et le bureau sont d'accord
- **PWA** installable sur téléphone : plein cadre, feuilles qui montent du bas,
  encoche et barre d'accueil respectées, composeur qui reste au-dessus du
  clavier iOS, cibles tactiles de 44 px — y compris dans le tiroir des
  discussions, dont le menu de ligne ne se cache plus derrière un survol
- **Raccourcis clavier** (`?` pour la liste). L'app se pilote entièrement au
  clavier : le focus entre dans un panneau quand il s'ouvre, Tab n'en sort pas,
  Échap le ferme et rend le focus au bouton d'origine — et chaque contrôle
  porte un anneau de focus visible, dérivé de l'accent choisi et maintenu à
  3:1 sur tous les fonds. Le tiroir mobile suit le même contrat, et fermé il
  disparaît de la tabulation comme des lecteurs d'écran au lieu de rester
  parcourable hors de l'écran
- **Détachement** d'un tour en cours (voir la limite ci-dessous)

### Robustesse

L'app reste utilisable quand le gateway ne l'est pas : bandeau hors-ligne,
reconnexion automatique avec backoff, et un message qui dit quoi faire plutôt
que de recopier l'erreur amont. Les échecs transitoires sont retentés — mais
seulement sur les lectures, jamais sur un tour d'agent. Un plafond local de
tours simultanés (3 par défaut) protège le Pi avant que celui du gateway (10)
n'entre en jeu. Le détail est dans [CLAUDE.md](CLAUDE.md).

### Agents : une équipe, et ce qu'elle coûte

Un agent, c'est un nom, un emoji, un métier en une ligne, un prompt système et
— si vous voulez — un modèle préféré. Quatre exemples sont créés à la première
ouverture : un généraliste, un chef d'équipe et deux spécialistes. Tout est
modifiable, duplicable et supprimable.

Ce prompt est renvoyé au gateway **à chaque message**, depuis le serveur. Ce n'est
pas un détail d'implémentation : la Sessions API ne relit jamais le
`system_prompt` enregistré à la création d'une conversation, et changer le
modèle d'une conversation l'efface même. Sans ce renvoi, la personnalité
disparaîtrait au deuxième message.

Cocher « peut piloter d'autres agents » compose automatiquement, à partir de la
fiche des agents choisis, la partie du prompt qui décrit l'équipe et explique
quand appeler `delegate_task` — l'outil de délégation de Hermes Agent, avec sa
récursion (`role: "orchestrator"`). Le bouton « Voir le prompt envoyé à chaque
message » montre exactement le texte produit, et le panneau dessine l'arbre de
l'équipe. Un agent ne peut pas se piloter lui-même, ni former une boucle : la
chaîne fautive est affichée au lieu d'être enregistrée.

**Ce que ça coûte.** Chaque sous-agent est un agent complet — terminal
compris — lancé sur le même Raspberry Pi 5 à quatre cœurs. Deux ou trois en
parallèle se sentent passer. Et un sous-agent ne voit rien de la conversation :
c'est au chef d'équipe de tout lui écrire.

**Ce que ça ne fait pas.** Les sous-agents ne sont pas streamés dans le fil :
sur la Sessions API, une délégation apparaît comme une étape d'outil
`delegate_task` avec son résultat — les événements `subagent.*` n'existent que
sur la Runs API, écartée par ailleurs. La profondeur et le nombre de sous-agents
simultanés sont réglés dans `~/.hermes/config.yaml` (`delegation.*`), pas ici.

### Skills : ce que l'éditeur fait, et ne fait pas

L'éditeur travaille sur les **fichiers** de `~/.hermes/skills`
(`<catégorie>/<skill>/SKILL.md`, plus un `DESCRIPTION.md` par catégorie), pas
sur ce que le gateway a chargé en mémoire. Conséquence à connaître :
**un skill créé ou renommé n'est pas forcément pris en compte tout de suite** —
`systemctl --user restart hermes-gateway` lève le doute.

Périmètre volontairement étroit : seuls `SKILL.md` et `DESCRIPTION.md` sont
lisibles et modifiables, il n'y a pas de suppression, les fichiers dépassant
256 Ko sont renvoyés vers la ligne de commande, et les fichiers cachés du
tri automatique de Hermes Agent (`.bundled_manifest`, `.curator_state`) ne sont ni
listés ni accessibles. Sans le montage `/skills` (voir `docker-compose.yml`),
le panneau s'affiche désactivé au lieu de casser.

### Providers : où vont les clés

Le panneau ne touche à aucun fichier lui-même. Il proxifie le **dashboard de
Hermes** (`hermes-dashboard.service`, sur `127.0.0.1:9119`), qui est le seul à
savoir écrire une clé correctement : `~/.hermes/.env` **et** les copies que
`config.yaml` en garde (`model.api_key`, `auxiliary.*.api_key`,
`custom_providers[*]`). Ces copies étant prioritaires, écrire `.env` tout seul
laisserait l'ancienne clé authentifier après une rotation.

Deux onglets, repris de la séparation du catalogue de Hermes Agent : **Clés API**
(une variable d'environnement à coller) et **Comptes** (une connexion OAuth).
Un troisième onglet change le **modèle par défaut** — celui de `config.yaml`,
qui ne s'applique qu'aux nouvelles discussions ; pour la conversation ouverte,
c'est le sélecteur en haut de l'écran.

Ce que le panneau ne fait pas : afficher une clé en clair. Le dashboard ne
renvoie qu'une valeur caviardée (`sk-o...60c6`), sa route de révélation n'est
pas proxifiée, et aucune valeur n'est journalisée. Les fournisseurs gérés par
une CLI tierce (Qwen, GitHub Copilot, `claude setup-token`) affichent la
commande à lancer plutôt qu'un bouton qui mentirait. Sans
`HERMES_DASHBOARD_TOKEN`, le panneau s'affiche désactivé et le reste de l'app
fonctionne normalement.

### Tâches planifiées : ce que Yadai fera sans vous

C'est le cron de Hermes Agent, pas un minuteur maison : la tâche tourne côté Pi avec
tous ses outils, et continue même app fermée.

**L'horaire se choisit, il ne s'écrit pas.** « Chaque jour », « chaque
semaine », « chaque mois », « à intervalle » ou « une seule fois » ouvrent les
champs correspondants (une heure, un jour, un nombre) ; le panneau en fabrique
l'expression que le cron attend et traduit en français ce qu'elle veut dire avant
l'enregistrement — il répond `500` à un horaire illisible, autant ne jamais
l'envoyer. Le mode « Expression » reste là pour ce que les menus ne couvrent pas
(`0 9-18 * * 1-5`), et une tâche écrite ainsi se rouvre telle quelle.

**Une tâche appartient à un agent.** Choisissez-le au moment de la planifier :
sa fiche part avec la tâche, donc elle s'exécute avec sa personnalité et son
équipe, exactement comme dans une conversation. Sans agent, c'est le prompt par
défaut de Yadai. Attention : la fiche est recopiée à l'enregistrement, pas
relue à chaque exécution — si vous modifiez l'agent ensuite, la tâche le signale
et un bouton « Mettre à jour » la remet à niveau.

Deux choses à savoir. **L'instruction doit se suffire à elle-même** : la tâche
s'exécute dans sa propre conversation, sans le contexte de celle qui est
ouverte. Et **la livraison se choisit** : « Local » garde la sortie côté Pi,
sinon le résultat part sur une plateforme dont le canal d'accueil est configuré
(Telegram, typiquement) — les autres ne sont pas proposées, parce qu'elles
résoudraient vers rien.

Une tâche existante se modifie (nom, horaire, agent, instruction, livraison) ou
se duplique pour en dériver une variante. Seule exception : une tâche « une
seule fois » déjà passée demande une nouvelle date, parce que le cron refuse de
reprogrammer un horaire écoulé.

Le panneau se désactive proprement si le gateway tourne sans son module cron.

### Notifications : ce qu'il faut faire une fois

Sur **iPhone**, le Web Push n'existe que pour une app **installée sur l'écran
d'accueil** : ouvrez Yadai dans Safari, bouton Partager → « Sur l'écran
d'accueil », puis rouvrez-la depuis l'icône. Le panneau d'état (`⌘/`) affiche
alors « Activer sur cet appareil » ; l'autorisation se demande depuis ce bouton,
jamais toute seule. Le bouton « Envoyer un test » permet de vérifier tout de
suite, sans attendre un vrai tour. Chaque appareil s'abonne séparément et peut
être retiré depuis la liste.

Côté serveur il faut une paire de clés VAPID dans `.env` (`VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — voir `.env.example` pour la commande de
génération). Sans elles, la section s'affiche désactivée et le reste de l'app
fonctionne normalement.

Ce qui déclenche une notification : **un tour lancé depuis cette interface** qui
se termine alors que personne ne le regardait — app fermée, écran verrouillé, ou
onglet en arrière-plan. Ce qui n'en déclenche **pas** : les tâches planifiées et
les conversations Telegram, qui ne passent pas par ce flux.

### Une limite à connaître

Le bouton carré pendant la génération **arrête l'affichage, pas l'agent**.
L'API du gateway n'expose aucun moyen d'interrompre un tour lancé par la
Sessions API : le tour se termine en arrière-plan et sa réponse apparaît dans
la conversation (bouton « Recharger »). Le détail et l'alternative écartée sont
documentés dans [CLAUDE.md](CLAUDE.md#2-un-tour-de-la-sessions-api-ne-peut-pas-être-interrompu).
Le serveur, lui, suit désormais le tour jusqu'au bout même sans navigateur —
c'est ce qui lui permet de notifier à la fin.

L'historique reste dans `~/.hermes/state.db` — le même que celui du CLI et du
bot Telegram. Les conversations démarrées ailleurs apparaissent ici.

## Prérequis

- Hermes Agent installé et le gateway lancé (`systemctl --user status hermes-gateway`)
- Node 22+ (ou Docker) et Tailscale

## Installation

### 1. Activer le serveur API de Hermes

Dans `~/.hermes/.env` :

```bash
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
API_SERVER_KEY=$(openssl rand -hex 32)   # ≥16 caractères, sinon Hermes refuse de démarrer
```

Puis, dans `~/.hermes/config.yaml`, donner à la plateforme `api_server` le même
jeu d'outils qu'à Telegram :

```yaml
platform_toolsets:
  api_server:
    - browser
    - code_execution
    - file
    - memory
    - skills
    - terminal
    - web
    # …
```

Hermes ne relit pas `.env` à chaud :

```bash
systemctl --user restart hermes-gateway
curl -s http://127.0.0.1:8642/health
```

### 2. Configurer l'app

```bash
cp .env.example .env
$EDITOR .env          # HERMES_API_KEY = la même valeur que API_SERVER_KEY
chmod 600 .env
```

`HERMES_SKILLS_DIR` (défaut `/home/pi/.hermes/skills`) est le répertoire monté
en lecture-écriture dans le conteneur pour l'éditeur de skills. Retirez le
volume dans `docker-compose.yml` si vous préférez que l'app n'écrive nulle
part hors de `data/`.

Pour le panneau Providers, renseignez aussi `HERMES_DASHBOARD_TOKEN` avec la
valeur de `HERMES_DASHBOARD_SESSION_TOKEN` du dashboard :

```bash
systemctl --user status hermes-dashboard      # doit être actif sur 9119
grep HERMES_DASHBOARD_SESSION_TOKEN ~/.hermes/dashboard.env
```

Le jeton vient de ce fichier, que l'unité systemd lit via `EnvironmentFile` :
il survit aux redémarrages du service. Laissez la variable vide et le panneau
se désactive proprement.

Pour les notifications push, générez une paire de clés VAPID une bonne fois :

```bash
node -e "const {createECDH}=require('node:crypto');const k=createECDH('prime256v1');k.generateKeys();console.log('VAPID_PUBLIC_KEY='+k.getPublicKey().toString('base64url'));console.log('VAPID_PRIVATE_KEY='+k.getPrivateKey().toString('base64url'))"
```

Collez les deux lignes dans `.env`, ajoutez `VAPID_SUBJECT=mailto:vous@exemple.fr`.
La clé publique est servie au navigateur (c'est son rôle) ; la privée signe les
requêtes vers le service de push et ne quitte pas le serveur. Les regénérer
invalide tous les abonnements : chaque appareil devra être réactivé.

### 3. Lancer

Docker (recommandé) :

```bash
docker compose up -d --build
```

Ou directement avec Node :

```bash
npm ci && npm run build && npm start
```

### 4. Publier sur le tailnet

```bash
./scripts/tailscale-serve.sh
```

Le script affiche l'URL `https://<machine>.<tailnet>.ts.net` ; reportez-la dans
`HERMES_PUBLIC_ORIGIN` puis reconstruisez. Ouvrez-la sur le téléphone et
« Ajouter à l'écran d'accueil ».

### 5. Vérifier

```bash
./scripts/smoke.sh
```

Le test bloquant est le streaming : il échoue si les tokens n'arrivent pas en
trames SSE séparées, ce qui signalerait un proxy qui bufferise.

### 6. Sauvegardes

```bash
crontab -e
# 17 3 * * *  /opt/stacks/Hermes-Ui/scripts/backup.sh >> /var/log/hermes-backup.log 2>&1
```

Sauvegarde `state.db` (historique + mémoire), `config.yaml`, les `.env` et la
base de l'UI. Renseignez `BACKUP_REMOTE` pour une copie hors-Pi.

## Pourquoi Tailscale plutôt que Cloudflare

Cloudflare bufferise `text/event-stream` et coupe la requête au bout de 100 s
(erreur 524, *Proxy Read Timeout*, fixe sur Free/Pro/Business). Un tour d'agent
qui réfléchit et enchaîne des outils dépasse régulièrement ce délai. Tailscale
Serve n'impose ni buffering ni durée maximale.

Si un accès hors-tailnet devient nécessaire : Cloudflare Tunnel + Access
(One-Time PIN restreint à votre adresse), avec des heartbeats SSE plus
fréquents que 100 s — en acceptant que ça reste fragile.

## Sécurité

Le serveur API de Hermes exécute **tout le toolset, terminal compris, sur le
Pi**. `API_SERVER_KEY` est un secret équivalent-root :

- Hermes reste sur `127.0.0.1:8642`
- le conteneur ne publie que sur `127.0.0.1:3000`
- la clé ne quitte jamais le proxy SvelteKit
- aucun port n'est ouvert sur la box
- l'éditeur de skills n'écrit que deux noms de fichiers, sous un chemin résolu
  par `realpath` et vérifié comme étant à l'intérieur du répertoire monté :
  ni `..`, ni lien symbolique, ni fichier caché n'en sortent
- `HERMES_DASHBOARD_TOKEN` (dashboard sur `127.0.0.1:9119`) est un second
  secret du même ordre — il ouvre l'écriture de la configuration de Hermes Agent. Il
  reste lui aussi côté serveur, et aucune clé d'API n'est renvoyée en clair au
  navigateur ni écrite dans les journaux
- `VAPID_PRIVATE_KEY` ne quitte pas le serveur non plus, et les adresses
  d'abonnement push (qui suffiraient à pousser vers un appareil) ne sont jamais
  renvoyées au navigateur : la liste des appareils n'affiche qu'un condensé et
  le nom du service de push. Le contenu des notifications est chiffré de bout en
  bout (RFC 8291) : le service d'Apple ou de Google relaie sans pouvoir lire

## Notes matérielles

Placez `~/.hermes/state.db` et `data/` sur un SSD. Les écritures SQLite
fréquentes usent rapidement une carte SD.

## Amélioration automatique quotidienne

Un timer systemd sur le Pi lance Claude Code chaque jour à 05:00. Il travaille
dans un clone isolé du dépôt sur un thème qui tourne avec les jours de la
semaine (robustesse, fonctionnalité, performance, simplification,
accessibilité, tests, intégration Hermes Agent), vérifie son travail avec
`npm run check`, `npm test` et `npm run build`, **déploie le résultat sur
l'application** (fast-forward + rebuild Docker + smoke test, retour arrière
automatique en cas d'échec), puis pousse sur GitHub et notifie Discord.

`main` sur GitHub reflète donc ce qui tourne réellement. Une sauvegarde
horodatée est prise avant chaque exécution, et le message Discord contient la
commande de retour arrière prête à coller.

Le runner vit dans `/opt/stacks/hermes-ui-bot/` (hors dépôt, pour qu'une
mauvaise PR ne puisse pas casser le mécanisme) et sa documentation est dans
`/opt/stacks/hermes-ui-bot/README.md`.

Pour lancer une amélioration **à la main**, sans passer par la routine :
[AMELIORER.md](AMELIORER.md) décrit la même procédure de bout en bout —
sauvegarde, vérification, déploiement, push, capture et notification Discord.
Le prompt à coller dans une session Claude Code neuve :

```
Tu travailles sur Yadai, mon interface web pour Hermes Agent, sur ce Raspberry Pi.
Lis /opt/stacks/Hermes-Ui/CLAUDE.md puis /opt/stacks/Hermes-Ui/AMELIORER.md,
et applique AMELIORER.md de bout en bout.
Ce que je veux : <ta demande, ou « choisis toi-même »>
```

## Documentation développeur

Voir [CLAUDE.md](CLAUDE.md) : contrat exact de l'API, pièges vérifiés
(identifiant de modèle, mécanisme d'arrêt, limites du multimodal) et
conventions du code.
