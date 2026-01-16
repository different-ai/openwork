# OpenWork Chrome Extension - Guía de Instalación y Publicación

Esta guía te ayudará a instalar la extensión de OpenWork en Chrome y, opcionalmente, a publicarla en la Chrome Web Store.

## 📋 Tabla de Contenidos

1. [Requisitos Previos](#requisitos-previos)
2. [Instalación Local (Modo Desarrollo)](#instalación-local-modo-desarrollo)
3. [Uso de la Extensión](#uso-de-la-extensión)
4. [Compilar la Extensión](#compilar-la-extensión)
5. [Publicar en Chrome Web Store](#publicar-en-chrome-web-store)
6. [Solución de Problemas](#solución-de-problemas)

---

## Requisitos Previos

### Para usar la extensión:
- Google Chrome (versión 114 o superior, con soporte para Side Panel)
- Un servidor OpenCode corriendo localmente (ejecuta `opencode serve` en tu proyecto)

### Para compilar la extensión:
- Node.js 18 o superior
- npm o pnpm

---

## Instalación Local (Modo Desarrollo)

### Paso 1: Compilar la extensión

```bash
# Navega al directorio de la extensión
cd chrome-extension

# Instala las dependencias
npm install

# Compila la extensión
npm run build
```

Esto creará una carpeta `dist/` con todos los archivos necesarios para la extensión.

### Paso 2: Cargar la extensión en Chrome

1. Abre Google Chrome
2. Ve a `chrome://extensions` en la barra de direcciones
3. Activa el **"Modo desarrollador"** (interruptor en la esquina superior derecha)
4. Haz clic en **"Cargar descomprimida"** (Load unpacked)
5. Selecciona la carpeta `chrome-extension/dist` del proyecto

![Modo desarrollador](https://developer.chrome.com/static/docs/extensions/get-started/tutorial/hello-world/image/extensions-page-e0d64d89a6acf_1920.png)

### Paso 3: Anclar la extensión (Opcional)

1. Haz clic en el icono de extensiones (pieza de puzzle) en la barra de herramientas
2. Busca "OpenWork" en la lista
3. Haz clic en el icono de pin para anclarla

---

## Uso de la Extensión

### Requisito: Servidor OpenCode

Antes de usar la extensión, asegúrate de tener OpenCode corriendo:

```bash
# En la carpeta de tu proyecto
opencode serve
```

Por defecto, el servidor corre en `http://127.0.0.1:4096`.

### Abrir el Side Panel

1. **Opción 1:** Haz clic en el icono de OpenWork en la barra de herramientas de Chrome
2. **Opción 2:** Usa el atajo de teclado para abrir el side panel de Chrome

### Conectarse al servidor

1. Al abrir el side panel, verás la pantalla de conexión
2. Ingresa la URL del servidor (por defecto: `http://127.0.0.1:4096`)
3. Opcionalmente, ingresa el directorio si el servidor maneja múltiples workspaces
4. Haz clic en **"Connect"**

### Funcionalidades disponibles

- **Dashboard:** Vista principal con acceso rápido a sesiones recientes y templates
- **Sessions:** Lista de todas las sesiones/tareas
- **Templates:** Guarda y ejecuta workflows reutilizables
- **Settings:** Configura el modelo por defecto y gestiona la conexión

### Crear una nueva tarea

1. Desde el Dashboard, haz clic en **"New Task"**
2. Escribe tu solicitud en el campo de texto
3. Presiona Enter o haz clic en el botón de enviar
4. OpenWork ejecutará la tarea y mostrará el progreso en tiempo real

### Permisos

Cuando OpenCode necesite permisos especiales (como acceso a archivos), verás un modal de permisos. Puedes:
- **Deny:** Denegar el permiso
- **Once:** Permitir una sola vez
- **Allow:** Permitir siempre

---

## Compilar la Extensión

### Desarrollo continuo

```bash
cd chrome-extension
npm run dev
```

Esto inicia un servidor de desarrollo. Los cambios se reflejarán automáticamente.

### Compilación de producción

```bash
cd chrome-extension
npm run build
```

Los archivos compilados estarán en `chrome-extension/dist/`.

### Estructura del build

```
dist/
├── manifest.json       # Configuración de la extensión
├── sidepanel.html      # HTML del side panel
├── sidepanel.js        # Código JavaScript del side panel
├── background.js       # Service worker
├── styles.css          # Estilos
└── icons/              # Iconos de la extensión
    ├── icon-16.png
    ├── icon-32.png
    ├── icon-48.png
    └── icon-128.png
```

---

## Publicar en Chrome Web Store

### Requisitos para publicar

1. **Cuenta de desarrollador de Chrome Web Store** ($5 USD, pago único)
   - Regístrate en: https://chrome.google.com/webstore/devconsole
   
2. **Activos gráficos requeridos:**
   - Iconos de extensión: 128x128 px (ya incluido)
   - Capturas de pantalla: mínimo 1, máximo 5 (1280x800 o 640x400 px)
   - Icono promocional pequeño: 440x280 px (opcional)
   - Icono promocional grande: 920x680 px (opcional)
   - Marquee promotional tile: 1400x560 px (opcional)

### Pasos para publicar

#### 1. Preparar el paquete

```bash
# Desde la raíz del proyecto
cd chrome-extension

# Compila la extensión
npm run build

# Crea un archivo ZIP de la carpeta dist
cd dist
zip -r ../openwork-extension.zip .
```

#### 2. Crear la entrada en Chrome Web Store

1. Ve a la [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Haz clic en **"New Item"**
3. Sube el archivo `openwork-extension.zip`

#### 3. Completar la información de la extensión

**Información básica:**
- **Nombre:** OpenWork
- **Descripción corta:** AI-powered task runner for OpenCode
- **Descripción detallada:**
  ```
  OpenWork es una extensión de Chrome que te permite conectarte a tu servidor OpenCode 
  y ejecutar tareas directamente desde el navegador.
  
  Características:
  • Side panel integrado para acceso rápido
  • Conexión a servidor OpenCode local
  • Gestión de sesiones y tareas
  • Templates reutilizables
  • Sistema de permisos transparente
  • Actualizaciones en tiempo real via SSE
  
  Requisitos:
  • Servidor OpenCode corriendo localmente
  • Chrome 114 o superior
  ```

**Categoría:** Productivity

**Idioma:** English (o tu preferencia)

#### 4. Subir activos gráficos

- Sube las capturas de pantalla de la extensión en funcionamiento
- Sube el icono promocional si lo tienes

#### 5. Configurar distribución

- **Visibilidad:** Public (para que cualquiera pueda instalarla)
- **Regiones:** Selecciona donde estará disponible

#### 6. Declarar permisos

En la sección de "Privacy practices", declara:
- **Storage:** Para guardar preferencias del usuario
- **Host permissions:** Para conectarse a localhost (servidor OpenCode)

#### 7. Enviar para revisión

1. Haz clic en **"Submit for Review"**
2. La revisión normalmente toma 1-3 días hábiles
3. Recibirás un email cuando sea aprobada o si necesita cambios

### Actualizar la extensión

1. Incrementa la versión en `manifest.json`
2. Recompila y crea un nuevo ZIP
3. Ve al Developer Dashboard
4. Selecciona tu extensión
5. Haz clic en "Package" > "Upload new package"
6. Sube el nuevo ZIP y envía para revisión

---

## Solución de Problemas

### "No se puede conectar al servidor"

1. Verifica que OpenCode esté corriendo:
   ```bash
   opencode serve
   ```
2. Asegúrate de que la URL sea correcta (por defecto: `http://127.0.0.1:4096`)
3. Verifica que no haya un firewall bloqueando la conexión

### "La extensión no aparece en Chrome"

1. Asegúrate de estar en Chrome 114 o superior
2. Verifica que el "Modo desarrollador" esté activado
3. Recarga la extensión en `chrome://extensions`

### "El Side Panel no se abre"

1. Chrome necesita que hagas clic en el icono de la extensión para abrir el side panel
2. Si no funciona, intenta cerrar y reabrir Chrome

### "Errores de compilación"

1. Elimina `node_modules` y reinstala:
   ```bash
   rm -rf node_modules
   npm install
   ```
2. Verifica que Node.js 18+ esté instalado:
   ```bash
   node --version
   ```

### "Los cambios no se reflejan"

1. Después de recompilar, ve a `chrome://extensions`
2. Haz clic en el botón de "Actualizar" de la extensión
3. Cierra y reabre el side panel

---

## Recursos Adicionales

- [Documentación de Chrome Extensions](https://developer.chrome.com/docs/extensions)
- [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [OpenCode Documentation](https://opencode.ai)
- [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)

---

## Soporte

Si tienes problemas o preguntas, puedes:
1. Abrir un issue en el repositorio de GitHub
2. Revisar la documentación de OpenCode
3. Contactar al equipo de desarrollo

---

¡Disfruta usando OpenWork desde tu navegador! 🚀
