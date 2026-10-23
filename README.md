# ArtisanApp V18

Frontend monolithique conservé dans `index.html.html`. Le fichier legacy `ArtisanApp-Web.txt` n'est pas utilisé ni fusionné.

## Lancer en local

Prérequis : Node.js 20 ou ultérieur. Le serveur utilise uniquement les modules natifs de Node, sans installation de dépendances.

1. Copier `.env.example` vers `.env` localement et renseigner les clés fournisseur directement dans le fichier local. Ne jamais commiter `.env`.
2. Dans PowerShell, lancer `node --env-file=.env server.mjs` depuis le dossier du projet.
3. Ouvrir `http://127.0.0.1:4173`.

Attention : `localStorage` est isolé par origine. Les données créées en ouvrant directement `index.html.html` avec `file://` ne sont pas automatiquement visibles sur `http://127.0.0.1:4173`. Avant de changer de mode, exportez les données depuis l'ancienne origine et importez le JSON depuis la nouvelle; gardez une copie du fichier exporté jusqu'à vérification.

Sans clés, l'application et les fonctions sans IA restent accessibles; les endpoints IA renvoient une erreur explicite « non configuré ». `/api/health` indique uniquement les capacités configurées et n'expose aucune valeur secrète.

## Agnès et devis

Agnès utilise l'API Chat Completions DeepSeek via `DEEPSEEK_API_KEY`. Les devis sont des propositions de lignes sans prix; quantités, prix, TVA et totaux restent soumis au contrôle de l'utilisateur et au moteur existant de l'application.

## Retouche photo

Le langage et la reformulation d'instructions passent par DeepSeek. La modification d'image est exécutée par l'API d'édition d'images configurée via `OPENAI_IMAGE_API_KEY` et `OPENAI_IMAGE_MODEL` (GPT Image 2.5 Sunburst par défaut). Ce fournisseur est distinct du modèle de langage. L'image n'est envoyée qu'après clic sur « Modifier avec Agnès »; le serveur la traite en mémoire, valide PNG/JPEG, taille maximale et dimensions, et ne l'écrit pas sur disque. L'appel peut entraîner des frais fournisseur et transmettre la photo ainsi que les instructions au fournisseur externe.

## Email et pièce jointe

EmailJS reste le transport existant. Pour joindre un PDF, la clé de variable EmailJS `document_pdf` doit être configurée comme pièce jointe dynamique de type **Variable Attachment** dans le template, avec le type de contenu `application/pdf`. L'application envoie le PDF encodé en data URL via cette variable. Envoi sans attachement désactivé par défaut dans l'écran d'envoi. Le statut d'un devis n'est actualisé qu'après succès EmailJS; `mailto:` reste une ouverture d'application externe et n'est jamais comptée comme envoi confirmé.

La Public Key EmailJS n'est pas un secret et reste visible dans le navigateur. Restreignez les domaines autorisés, configurez les limites anti-abus du compte et surveillez les quotas. Une garantie plus forte nécessite un relais serveur authentifié; aucun secret SMTP n'est stocké dans le frontend.

## Limites de déploiement

Ce serveur est un serveur de développement local. Il n'a ni authentification utilisateur, ni base de données, ni stockage multi-tenant. Il écoute par défaut uniquement sur `127.0.0.1`; ne le publiez pas directement sur Internet. Un déploiement professionnel nécessite d'abord une authentification, des autorisations, des limites d'usage adaptées, TLS, gestion des secrets côté hébergeur et une revue sécurité. Aucun compte fournisseur ni aucune clé ne sont fournis par ce projet.
