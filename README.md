### Token creation
```cmd
node ./dist/index.js createtoken --name "TOKEN_NAME" --symbol "TS" --image "TOKEN_IMAGE_LINK" --decimals 5 --website "web_link" --initial-minting 1000000 --url devnet
```

### Market creation
```cmd
node ./dist/index.js createmarket --base BASE_TOKEN_ADDRESS --quote "So11111111111111111111111111111111111111112" --order-size 0.01 --price-tick 0.1 --url devnet
```

### Pool creation
```cmd
node ./dist/index.js createpool --market MAREKET_ID --baseAmount 100000 --quoteAmount 0.1 --url devnet
```

### Buy
```cmd
node ./dist/index.js buy --pool POOL_ID --buy-token 'base' --amount 100
```

### BUY SELL
node ./dist/index.js buysell --pool "POOL_ID" --amount 0.02 --input-amount-type 'quote' --first-buy 'base' --url 'devnet'

* EX: base = `your token` | quote = `sol`

- `input-amount-type == quote` means give will be send to buy base and this will be get on sell (0.02 sol use to buy and sell)

- `input-amount-type == base` means will buy buy base and this will be get on sell (0.02 buy and sell with 0.02 your token amoun)


### Add Liquidity
```cmd
node ./dist/index.js addliquidity --pool POOL_ID --amount 100 --amount-side 'base'
```

### Remove Liquidity
```cmd
node ./dist/index.js removeliquidity --pool POOL_ID --amount -1 --url 'devnet'
```

### Revoke Authority:
```cmd
node ./dist/index.js revokeauth --token "TOKEN_ADDRESS" --url 'devnet'
```

### Unwrap Sol:
```cmd
node ./dist/index.js unwrap --url 'mainnet'
```

### Create Pool And Buy:
```cmd
node ./dist/index.js create-and-buy --market "MARKET_ID" --base-amount 1000 --quote-amount 1 --buy-token 'base' --buy-amount 10 --url 'mainnet'
```