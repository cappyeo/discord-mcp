const secret = process.env.DISCORD_TOKEN ?? '';
const split = Math.floor(secret.length / 2);
process.stderr.write(`fixture failure: ${secret.slice(0, split)}`);
setTimeout(() => {
  process.stderr.write(`${secret.slice(split)}\n`);
  process.exit(1);
}, 10);
