// 調べもの用：CDP でつないだページで式を 1 つ評価して表示する。node eval.mjs <port> "<式>"
import { connect } from './cdp.mjs';
const [port, expr] = process.argv.slice(2);
const cdp = await connect(Number(port), { match: process.env.MATCH ?? 'aquarium' });
try {
  console.log(JSON.stringify(await cdp.evaluate(expr), null, 1));
} finally {
  cdp.close();
}
