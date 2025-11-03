// ESLint 9.x flat config format (CommonJS)
module.exports = [
    {
        ignores: [
            'node_modules/**',
            'dist/**',
            'dev-dist/**',
            '*.min.js',
            'X4FProjector/**',
            'x4_extracted_data/**',
            'data/**'
        ]
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: 'commonjs',
            globals: {
                console: 'readonly',
                process: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                module: 'readonly',
                require: 'readonly',
                exports: 'writable',
                Buffer: 'readonly',
                setInterval: 'readonly',
                setTimeout: 'readonly',
                clearInterval: 'readonly',
                clearTimeout: 'readonly'
            }
        },
        rules: {
            'indent': ['warn', 4],
            'linebreak-style': process.platform === 'win32' ? 'off' : ['error', 'unix'],
            'quotes': ['warn', 'single', { avoidEscape: true }],
            'semi': ['error', 'always'],
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-console': 'off',
            'no-constant-condition': 'warn',
            'no-empty': 'warn',
            'no-extra-semi': 'error',
            'no-unreachable': 'warn',
            'eqeqeq': ['warn', 'always'],
            'curly': ['warn', 'all'],
            'brace-style': ['warn', '1tbs'],
            'comma-spacing': ['warn', { before: false, after: true }],
            'key-spacing': ['warn', { beforeColon: false, afterColon: true }],
            'space-before-blocks': ['warn', 'always'],
            'arrow-spacing': ['warn', { before: true, after: true }],
            'no-var': 'warn',
            'prefer-const': 'warn'
        }
    }
];
