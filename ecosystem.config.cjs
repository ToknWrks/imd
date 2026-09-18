// PM2 config for the IMD Launchpad Terminal
// Start:   npm start            (or: ./imd.sh start)
// Restart: ./imd.sh restart      (or: npm run restart)
// Stop:    ./imd.sh stop         (or: npm run stop)
// Logs:    ./imd.sh logs
// Status:  ./imd.sh status
//
// Dashboard + dip-watcher. The watcher executes scheduled buys and dip
// triggers from accumulation_strategies — without it, plans never fire.
//
// Port defaults to 4210 because 4200 belongs to /accumulate (both apps live
// on this machine). Override with IMD_DASHBOARD_PORT if that ever changes.

const port = process.env.IMD_DASHBOARD_PORT || "4210";

module.exports = {
  apps: [
    {
      name: "imd-dashboard",
      script: "node",
      args: "dashboard.mjs",
      cwd: __dirname,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        DASHBOARD_PORT: port,
      },
    },
    {
      name: "imd-watcher",
      script: "node",
      args: "dip-watcher.mjs",
      cwd: __dirname,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
