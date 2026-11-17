// Renderer entry. Screens are added step by step.
const app = document.getElementById('app')!;
declare global { interface Window { steady: any } }
(async () => {
  const cfg = await window.steady.config();
  app.innerHTML = cfg.hasKey
    ? '<h1>STEADY</h1><p>Key found.</p>'
    : '<h1>STEADY</h1><div class="panel"><h2>Set PRESAGE_API_KEY in .env</h2><p>Copy <code>.env.example</code> to <code>.env</code>, paste your key, restart.</p></div>';
})();
export {};
