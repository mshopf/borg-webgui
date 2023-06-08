Hash your password:
node -e 'async function m() { rl=require("readline").promises.createInterface({ input: process.stdin, output: process.stdout, terminal: true}); p=await rl.question("Password: "); rl.close(); console.log (await require ("argon2").hash(p));} m()'
