// Configuración de PM2 para correr el Analizador IA como servicio en
// producción. Ver DEPLOY.md para la puesta en marcha inicial y el flujo de
// despliegue día a día.
module.exports = {
    apps: [
        {
            name: 'analizador-ia-documentos-carga',
            script: 'server/index.js',
            cwd: __dirname,
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            max_restarts: 10,
            restart_delay: 3000,
            env: {
                NODE_ENV: 'production',
            },
            out_file: './logs/out.log',
            error_file: './logs/error.log',
            time: true,
        },
    ],
};
