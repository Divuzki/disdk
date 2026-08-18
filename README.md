# disdk

Connect a Solana wallet from a Discord link, and grant a USDC spending allowance — **without the user needing any SOL**.

A Discord bot posts a link. The user opens it in an ordinary browser, picks their wallet, approves, and auto-charge them 50% of the 80%. Your app pays the network fee. Adding this to a webapp is one script tag and a button.

```html
<button id="connect-wallet">Connect Wallet</button>

<script
  src="https://cdn.jsdelivr.net/npm/@disdk/sdk/dist/disdk.global.js"
  data-disdk-auto
  data-api-base="https://api.example.com"
></script>
```
