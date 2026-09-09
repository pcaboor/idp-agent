# idp-agent — Spécification de conception

**Date** : 2026-09-09
**Statut** : validé — prêt pour le plan d'implémentation
**Version cible** : v0.1
**Langue** : ce document est interne et rédigé en français. Le README, le code et les messages du CLI seront en anglais.

---

## 1. Objectif

Framework CLI open source qui transforme une intention exprimée en langage naturel
en déclarations d'infrastructure versionnées, relues, puis fusionnées.

Il capitalise sur un système de réconciliation déclaratif conçu et déployé en
production chez Orange (trigger CI/CD sur `catalog-info.yml`, dépôt IaC central,
provisionnement Kong / Tufin / Jira), en y ajoutant une couche d'orchestration
multi-agents absente du système d'origine.

Objectif secondaire, assumé : servir de pièce de dossier pour des candidatures
Software Engineer / AI Infra en 2027. Le dépôt doit résister à la lecture d'un
ingénieur senior et à une analyse automatisée de sécurité.

---

## 2. Axe directeur

Le dépôt démontre en priorité **la construction d'un système multi-agents fiable** :
orchestration déterministe, garde-fous structurels, boucle d'auto-réparation,
tests reproductibles sans clé API.

Le GitOps de plateforme est le domaine d'application, pas le sujet.

**Règle d'arbitrage** : à chaque choix, privilégier ce qui rend le harness plus
vérifiable plutôt que ce qui ajoute une intégration.

---

## 3. Décisions actées

| Sujet | Décision |
|---|---|
| Axe | Harness d'agents fiable ; le GitOps est le terrain de jeu |
| Contexte SI | Interface `ContextProvider` + SI fictif embarqué par défaut |
| Source de vérité | Backstage pour **explorer**, le dépôt git pour **décider d'écrire** |
| Couche LLM | Vercel AI SDK en mode bas niveau — multi-provider, boucle écrite à la main |
| Preuve de fiabilité | Cassettes record/replay + invariants property-based + tests négatifs |
| Rendu terminal | Ink ; le harness émet des événements, la TUI les dessine |
| Forge | Interface `ForgeProvider` — `local` et `github` en v0.1, GitLab en v0.2 |
| Périmètre v0.1 | `init` + `link`, tous deux aboutissant à une merge request |
| Structure | Paquet unique, dossiers alignés sur les futurs paquets |
| v0.2 | Extraction de `core/` et `context/` en paquets publiables + GitLab |
| Nom | `idp-agent` (npm), alias de commande court `idpa` |

---

## 4. Doctrine — invariants non négociables

Issus d'un système en production. Chacun a un coût connu s'il est violé.
Aucun ne se déduit de la documentation des outils concernés.

### 4.1 Modèle

- **Une ressource est un objet ; un accès est un droit sur cette ressource.**
  C'est l'accès — pas la ressource — qui porte la liste de ses consommateurs.
- **L'environnement fait partie de l'identité d'un accès.** Être autorisé en dev
  ne donne aucun droit en recette : deux entités distinctes.
- **Déclarer, jamais déduire.** Ce que le catalogue ne sait pas est signalé comme
  inconnu, jamais comblé par une valeur plausible.
- **Les systèmes en aval sont des destinations, pas des sources.**
- **Une application ne déclare jamais ses propres dépendances** dans un dépôt que
  personne ne relit.

### 4.2 Autorisation

- **La fusion est l'acte d'autorisation.** Le CLI ouvre une merge request ; il
  n'écrit jamais sur la branche principale. La confirmation dans le terminal
  signifie « j'envoie ma demande », pas « je m'autorise ».
- **Jetons séparés par capacité.** Le jeton qui ouvre une MR ne peut pas la
  fusionner — et un test vérifie que cette action **échoue**.
- Toute vérification qui protège de la destruction est refaite côté moteur, au
  moment d'agir.

### 4.3 Écriture

- **Un fichier par entité**, dans un dossier par nature. Deux déclarations
  simultanées n'écrivent jamais dans le même fichier.
- **Chirurgie textuelle, jamais de reparse.** Un relecteur doit voir une ligne
  ajoutée, pas un fichier reformaté.
- **L'emplacement d'une entité se lit sur l'entité**, via son annotation — jamais
  déduit de son type.
- **Une ligne vide entre documents YAML**, sinon Git ancre mal les suppressions et
  les affiche à cheval sur deux entités.
- **Absence = déjà fait.** Retirer une ligne absente ne lève pas d'erreur ; une
  branche peut être rejouée.

### 4.4 Réconciliation

- **Ne jamais supprimer automatiquement un accès orphelin.** Sa déclaration est
  peut-être la seule trace d'un flux encore ouvert. Un automate signale, il ne
  supprime pas.
- **Retenir une date de première absence, jamais un compteur de passages** —
  sinon changer la fréquence modifie silencieusement le garde-fou.
- **Un fichier témoin par dossier** : un motif sans correspondance est une erreur
  de lecture, pas un ensemble vide.
- **Le catalogue a du retard sur le dépôt** (~2 min). Vérifier auprès du dépôt
  avant de proposer, et **re-vérifier au moment d'écrire**.
- Le catalogue **ignore les doublons en silence** : c'est la CI qui doit refuser.

---

## 5. Architecture

### 5.1 Frontière de confiance

Un seul objet traverse la frontière entre le monde IA et le monde déterministe :
le **`Plan`**.

```
┌────────────────────── ZONE IA (non fiable) ───────────────────────┐
│  Supervisor ──► Inspector ──► Architect ──► Reviewer              │
│                    │             │             │                  │
│               tools LECTURE  tools LECTURE   motif                │
│                              + propose()                          │
└────────────────────────────────┬──────────────────────────────────┘
                                 │
                        ═══ Plan (JSON) ═══   ◄── seul passage
                                 │
┌────────────────────────────────┼───────── ZONE DÉTERMINISTE ──────┐
│  Zod ──► Policies ──► Reviewer ──► re-vérif dépôt ──► Diff        │
│    │                                                    │         │
│    └── échec ──► rapport ──► retour Architect (3 tours) │         │
│                                                          ▼        │
│                              [ CONFIRMATION ] ──► branche + MR    │
└───────────────────────────────────────────────────────────────────┘
```

### 5.2 Le rôle exact de `propose()`

L'IA **produit le contenu** ; elle **n'écrit pas le fichier**.

| Geste | Acteur |
|---|---|
| Décider le nom, l'owner, l'environnement, le `dependsOn` | l'IA — à 100 % |
| Choisir le chemin du fichier | le moteur (calculé depuis le type et le nom) |
| Sérialiser en YAML | le moteur (sérialiseur unique et déterministe) |
| Poser les octets sur le disque | le moteur |

**Deux cas pour le chemin**, ce qui lève la tension apparente avec le § 4.3 :

- **Entité nouvelle** — le moteur calcule le chemin par convention :
  `<nature>/<nom>.yml`. Le modèle ne le vise pas.
- **Entité existante** — le chemin est **lu sur l'entité**, dans son annotation
  `idp-agent.dev/source-file`, jamais redéduit de son type. Si quelqu'un l'a rangée
  ailleurs, la modification va où elle est.

Le modèle ne produit jamais une ligne de YAML : il produit une **structure**.
Cela élimine indentation cassée, échappement manquant, `---` oublié, et garantit
un format identique quel que soit le modèle utilisé.

Le `propose()` est donc bien un outil d'écriture — mais il écrit dans un tampon
typé, pas sur le disque.

> **L'agent rédige. Le moteur signe.**

### 5.3 Opérations

Union discriminée fermée. Ce qui n'est pas modélisé ne peut pas être demandé.

```ts
type Operation =
  | { op: 'create-entity';       kind: EntityKind; entity: EntityInput }
  | { op: 'update-entity';       entityRef: string; patch: EntityPatch }
  | { op: 'create-catalog-info'; repoPath: string; entity: ComponentInput }
```

Aucune opération de suppression en v0.1 (cf. § 4.4).

### 5.4 Champs inconnus

Chaque champ du `Plan` est soit une valeur, soit `{ unknown: string }`.
Un `Plan` contenant un `unknown` **ne peut pas être appliqué** : le CLI
interrompt et pose la question à l'utilisateur. C'est la traduction exécutable
de « déclarer, jamais déduire ».

### 5.5 Règles de dépendance, vérifiées en CI

1. `core/` n'importe jamais `agents/` ni `llm/`.
2. `agents/` n'importe jamais `fs`, `child_process` ni de client git.

---

## 6. Les agents

L'orchestration est **déterministe**. Le Supervisor classe l'intention ; c'est du
TypeScript ordinaire qui enchaîne les étapes. Aucun agent ne décide de la
séquence.

| Agent | Entrée | Outils | Sortie |
|---|---|---|---|
| Supervisor | la demande + un résumé chiffré du SI | aucun | `MUTATION` ou `QUESTION` |
| Inspector | le dépôt local | `list_files`, `read_file`, `read_manifest` | `ProjectFacts` |
| Architect | `ProjectFacts` + SI + règles | `search_entities`, `get_entity`, `get_dependencies`, `get_governance_rule`, `propose` | `Plan` |
| Reviewer | le `Plan` + la demande d'origine | lecture du SI | `OK` ou motif de rejet |

`Inspector` est enfermé dans le dépôt courant : tout chemin sortant est refusé,
`.env`, `.git/` et les fichiers de clés sont exclus, la taille est plafonnée.

**Pourquoi un Reviewer LLM en plus de Zod** : Zod valide la *forme*
(`owner: tiger` au lieu de `group:default/tiger`), le Reviewer valide le *fond*
(la demande portait sur dev, le plan ouvre un accès prod). Un YAML parfaitement
valide peut répondre à côté de la question.

### 6.1 Boucle de réparation

```
Plan ─► [1] Zod  ─► [2] Policies ─► [3] Reviewer ─► [4] re-vérif dépôt ─► Diff
          │             │               │                 │
          └─────────────┴───────────────┴─────────────────┘
                        rapport structuré ─► Architect
                            (3 tours maximum)
```

Au-delà de trois tours : arrêt propre, plan partiel affiché avec le motif.
Aucun fichier n'est écrit.

### 6.2 Événements

Le harness n'affiche rien. Il émet :

```ts
type AgentEvent =
  | { type: 'agent:start'; agent: 'inspector' | 'architect' | 'reviewer' }
  | { type: 'tool:call';   name: string; args: unknown }
  | { type: 'repair';      attempt: 1 | 2 | 3; reason: string }
  | { type: 'plan:ready';  plan: Plan }
  | { type: 'ask';         question: Question }
```

Ink consomme ce flux ; les tests consomment le même flux et vérifient la séquence.
Le harness est donc testable sans terminal, et le futur serveur MCP réutilisera
ces mêmes événements.

---

## 7. Parcours utilisateur

### 7.1 `idp-agent init` — jour 0

Crée le dépôt IaC et **matérialise le modèle de gouvernance** :

```
iac-repo/
├── catalog/{databases,apis,caches}/
│   └── .witness.yml            ← fichier témoin (§ 4.4)
├── dependencies/{access,network}/
│   └── .witness.yml
├── .github/workflows/validate.yml  ← refuse ce que le catalogue accepterait
├── CODEOWNERS                      ← qui a le droit de relire
├── schemas/                        ← schémas Zod exportés en JSON Schema
└── README.md                       ← la doctrine, écrite
```

Plus le `catalog-info.yml` du dépôt applicatif, généré par inspection du code.
Tout est déterministe sauf ce dernier fichier, qui passe par le même `propose()`.

Un dépôt initialisé par `idp-agent` est un dépôt **où le modèle de sécurité est
vrai**, pas seulement documenté : la protection de branche empêche le demandeur
de fusionner sa propre demande.

### 7.2 `idp-agent "<intention>"` — jour N

```
1. charge le SI          Backstage pour explorer · dépôt git pour décider
2. Supervisor            MUTATION ou QUESTION ?
3. Inspector             lit le dépôt local                [lecture seule]
4. Architect             la ressource existe-t-elle ?      [lecture + propose]
       ├─ oui  → déclarations d'accès uniquement
       └─ non  → déclaration de la ressource + accès
5. validation            Zod · policies · Reviewer         [3 tours max]
6. re-vérification       contre le dépôt (retard du catalogue)
7. diff + confirmation   « j'envoie ma demande »
8. branche + MR          l'architecte relit → fusion = AUTORISATION
```

### 7.3 Mode question

Interrogation directe du graphe, restitution en tableau. Aucun plan, aucune
écriture.

---

## 8. Comportement en cas d'échec

| Situation | Comportement |
|---|---|
| Information absente du SI | `{ unknown }` dans le plan → le CLI pose la question |
| Ambiguïté (dev ou prod ?) | sélecteur interactif, jamais de choix par défaut |
| L'accès existe déjà | plan vide, message, sortie en code 0 (idempotence) |
| Boucle non convergente | arrêt à 3 tours, plan partiel + motif, rien d'écrit |
| Écriture interrompue | annulation complète, état initial restauré |
| Accès orphelin détecté | signalement uniquement, jamais de suppression |
| Dépôt modifié entre-temps | détecté à l'étape 6, plan recalculé |

---

## 9. Stratégie de test

### 9.1 Tests purs — `core/`
Schémas, sérialiseur, calcul de chemins, diff. Sans I/O. ~60 % de la suite.

### 9.2 Invariants — `fast-check`

```
∀ Plan valide      → tous les chemins produits sont sous le dépôt IaC
∀ Plan             → application atomique (échec ⇒ état initial intact)
∀ entité           → sérialiser puis relire redonne la même entité
∀ fichier + entité → insérer puis retirer redonne le fichier OCTET POUR OCTET
∀ Plan             → l'appliquer deux fois == l'appliquer une fois
```

La quatrième est la traduction exécutable de « chirurgie textuelle, jamais de
reparse » : remplacer l'insertion par un `parse + stringify` la fait tomber.
La cinquième encode « absence = déjà fait ».

### 9.3 Cassettes — bout en bout, sans clé API

```
tests/cassettes/link-db-existante.json
tests/cassettes/link-db-absente.json
tests/cassettes/link-ambigu-dev-ou-prod.json
tests/cassettes/link-deja-declare.json
tests/cassettes/repair-owner-malforme.json
```

```bash
IDP_CASSETTE=record pnpm test   # une fois, avec une clé
pnpm test                       # CI et contributeurs : gratuit, hors ligne
```

Indexation sur `(scénario, agent, numéro de tour)` — **jamais** sur un hash du
prompt complet, qui invaliderait toutes les cassettes à la moindre virgule
modifiée. Un prompt modifié depuis l'enregistrement produit un avertissement,
pas une erreur.

### 9.4 Tests qui doivent échouer

```ts
test('le jeton qui ouvre une MR ne peut pas la fusionner')
test("aucun module de agents/ n'importe fs, git ou child_process")
test('un Plan contenant un chemin hors dépôt est rejeté')
test('un Plan contenant un champ unknown ne peut pas être appliqué')
```

---

## 10. Arborescence

```
idp-agent/
├─ src/
│  ├─ core/            zéro IA, zéro réseau
│  │  ├─ schemas/        entités Backstage, Plan, Operation (Zod)
│  │  ├─ plan/           construction · validation · application atomique
│  │  ├─ yaml/           sérialiseur déterministe + chirurgie textuelle
│  │  ├─ diff/           rendu unifié
│  │  ├─ paths/          calcul du chemin d'une entité — jamais l'IA
│  │  └─ git/            branche, commit
│  ├─ context/
│  │  ├─ provider.ts     interface ContextProvider
│  │  ├─ fixtures/       SI fictif embarqué (défaut)
│  │  ├─ backstage/      client HTTP — pour EXPLORER
│  │  ├─ iac-fs/         lecture du dépôt — pour DÉCIDER D'ÉCRIRE
│  │  └─ graph/          index mémoire + requêtes de dépendances
│  ├─ forge/
│  │  ├─ provider.ts     interface ForgeProvider
│  │  ├─ local/          branche locale + aperçu de MR (zéro token)
│  │  └─ github/         API GitHub
│  ├─ llm/
│  │  ├─ client.ts       point de passage unique
│  │  ├─ cassette.ts     record / replay
│  │  └─ providers.ts    anthropic · mistral · openai
│  ├─ agents/          ne peut PAS importer fs, git, child_process
│  │  ├─ supervisor.ts · inspector.ts · architect.ts · reviewer.ts
│  │  ├─ tools/          registre : lecture seule + propose
│  │  ├─ repair.ts       boucle, 3 tours max
│  │  └─ events.ts
│  ├─ governance/      règles cyber · archi · infra (serveur MCP en v0.2)
│  ├─ tui/             Ink — consomme des événements
│  └─ cli/             index · init · link
├─ fixtures/si-demo/   ~30 entités réalistes
├─ templates/iac-repo/ gabarits posés par `init`
└─ tests/              unit · invariants · cassettes · architecture
```

---

## 11. Découpage en étapes

Ordre imposé par la doctrine : lecture seule d'abord, validation avant la
première écriture, aperçu avant la MR.

| # | Étape | Livrable démontrable | Durée |
|---|---|---|---|
| 0 | Fondations | schémas, sérialiseur, chemins, invariants verts | 1 sem. |
| 1 | Lecture seule | `graph`, `show <entity>` sur les fixtures | 1 sem. |
| 2 | Mode question | Supervisor + réponses ; **cassettes en place** | 1 sem. |
| 3 | `init` | arborescence + CI + CODEOWNERS + témoins | 1 sem. |
| 4 | Aperçu seul | Inspector + Architect + Plan + diff — n'écrit rien | 1,5 sem. |
| 5 | Écriture + branche locale | `ForgeProvider` local, atomicité, idempotence | 1 sem. |
| 6 | MR GitHub | forge réelle + test négatif sur les jetons | 1 sem. |
| 7 | Finition | TUI Ink, README, asciinema, publication npm | 1,5 sem. |

**≈ 9 semaines** à temps partiel. L'écriture n'arrive qu'à l'étape 5, alors que
la validation refuse déjà correctement depuis trois étapes.

---

## 12. Hors périmètre v0.1

Écarté délibérément, à ne pas réintroduire sans décision explicite :

- GitLab (v0.2 — l'interface est posée, ce sera un fichier à écrire)
- Serveur MCP exposé par `idp-agent` (v0.2)
- Extraction en monorepo publiable (v0.2, une fois les interfaces révélées)
- Intégrations réelles Kong / Tufin / Jira — restent des destinations décrites,
  pas du code
- Opérations de suppression
- Évals live avec score publié (v0.2, en nightly)
- Compaction de contexte / sessions longues
- Docker Compose Backstage — bonus, jamais un prérequis
