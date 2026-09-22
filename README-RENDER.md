# WebView APK Build Worker

Build worker Docker pour générer automatiquement une application Android WebView.

## Paramètres

Les variables d'environnement utilisées sont :

- APP_URL
- APP_PACKAGE
- APP_NAME
- APP_ICON_URL

## Build

Le worker utilise le template :

https://github.com/xchacha20-poly1305/webview-apk-template

et exécute :

./gradlew assembleDebug

Le résultat est :

/builder/output/app-debug.apk

## Important

Ne jamais placer une clé privée de signature Android dans GitHub.

Pour la production, la signature APK/AAB doit être effectuée côté serveur avec des secrets Render.
