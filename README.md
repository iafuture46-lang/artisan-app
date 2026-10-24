# ArtisanApp V23

Application web métier pour gérer les clients, les devis, les factures et les documents associés.

## Architecture et lancement local

- `index.html` contient l'interface et le client Supabase. L'application utilise les tables `clients`, `documents` et `settings`.
- `server.mjs` sert l'interface et relaie les appels IA pour éviter d'exposer les clés fournisseur dans le navigateur.
- Le projet ne nécessite pas de dépendance npm; le serveur utilise Node.js 20 ou ultérieur et ses modules natifs.

Pour lancer localement :

1. Copier `.env.example` vers `.env` et ajouter localement les clés fournisseur nécessaires. Ne jamais commiter `.env`.
2. Depuis la racine du dépôt, exécuter `node --env-file=.env server.mjs`.
3. Ouvrir `http://127.0.0.1:4173`.

L'interface s'affiche sans attendre la connexion Cloud. Les modifications hors ligne restent uniquement en mémoire dans la session et ne sont pas garanties après rechargement. L'indicateur Cloud précise l'état de synchronisation. L'export JSON des Paramètres permet de télécharger les données chargées; il indique si des modifications locales restent non synchronisées. Le fichier exporté peut contenir des données personnelles.

## Devis, factures et PDF

Les devis et factures utilisent les mêmes vues de documents et le schéma Supabase existant. Les devis peuvent être édités, acceptés puis convertis en facture. La génération PDF s'appuie sur html2pdf chargé depuis un CDN.

Le formulaire de devis inclut un catalogue de prestations indicatif multi-métiers. Les prix restent modifiables; les tarifs ajustés sont mémorisés localement sur l'appareil et ne remplacent pas les prix des autres utilisateurs. Vérifiez chaque prix selon le chantier et vos coûts réels. Le récapitulatif calcule les totaux HT, les aléas, la TVA, le TTC et le montant HT restant après le coût matériaux saisi; il ne calcule pas les charges ou le coût de main-d’œuvre.

## Assistants IA

- La génération de propositions de lignes de devis passe par `/api/agnes/quote` et DeepSeek (`DEEPSEEK_API_KEY`). Les prix, quantités et totaux sont vérifiés et validés par l'utilisateur.
- L'aperçu de rénovation visuelle passe par `/api/photos/edit`. La retouche utilise le fournisseur d'images configuré par `OPENAI_IMAGE_API_KEY` et `OPENAI_IMAGE_MODEL`; les instructions sont reformulées côté serveur avec DeepSeek.
- Les clés fournisseur sont configurées uniquement dans l'environnement serveur. `/api/health` indique les capacités configurées sans révéler les secrets.

Les appels IA peuvent transmettre les textes ou photos choisis au fournisseur externe et entraîner des frais. Ils ne sont effectués qu'à la demande de l'utilisateur.

## Email et pièces jointes

L'envoi de devis et factures utilise EmailJS côté navigateur. Renseigner le Service ID, le Template ID et la clé publique dans Paramètres; cette configuration est stockée localement dans le navigateur et n'est pas synchronisée avec Supabase. La clé publique n'est pas un secret. Ne jamais saisir de clé privée dans ces champs.

Pour joindre le PDF, configurer dans le modèle EmailJS la variable `document_pdf` comme **Variable Attachment** avec le type `application/pdf`. L'application ne marque le devis comme envoyé qu'après réussite de l'envoi et de sa synchronisation Cloud.

## Limites de déploiement

`server.mjs` est un serveur de développement local, sans authentification utilisateur ni base multi-tenant. Il écoute par défaut uniquement sur `127.0.0.1`. Ne pas l'exposer directement sur Internet ni le déployer tel quel sur Render. Un déploiement professionnel nécessite notamment une authentification, des autorisations, une configuration TLS et une gestion des secrets côté hébergeur. Aucun déploiement Render n'est configuré ou vérifié par ce dépôt.
