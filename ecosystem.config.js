module.exports = {
    apps: [
        {
            name: 'ib-reminder',
            script: 'python3',
            args: 'server/app.py',
            cwd: '/root/ib-reminder',
            interpreter: 'none',
            env: {
                PORT: 5000,
                PYTHONPATH: '.'
            }
        }
    ]
};
