import { web3 } from "@project-serum/anchor";
import yargs, { command, option } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { addLiquidity, buySellWithBundle, createAndBuy, createMarket, createPool, createToken, mintTo, removeLiquidity, revokeAuthority, swap, unwrapSol } from "./txHandler";
import { getPubkeyFromStr, getSlippage } from "./utils";

const log = console.log;

const argv = yargs(hideBin(process.argv))
    .usage('Usage: $0 <command> [options]')
    .command('createtoken', 'token creation', yargs => {
        return yargs.option('name', {
            alias: 'n',
            describe: "Token name",
            type: "string",
            demandOption: "Token name is required"
        })
            .option('symbol', {
                alias: 's',
                describe: "Token symbol",
                type: "string",
            }).option('image', {
                alias: 'i',
                describe: "token image/logo url",
                type: "string",
            }).option('decimals', {
                alias: 'd',
                describe: "token decimals (default: 6)",
                default: 6,
                type: 'number'
            }).option("website", {
                alias: 'w',
                describe: "external website link",
                type: 'string'
            }).option("initial-minting", {
                alias: 'im',
                describe: "How many token you want to mint initially ? (default: 0)",
                type: 'number',
                default: 0
            }).option("url", {
                alias: 'u',
                describe: "network type (devnet/mainnet) default (mainnet)",
                type: 'string',
                default: "mainnet"
            })

    }, async (argv) => {
        const { name, symbol, image, decimals, website, url, initialMinting } = argv
        log({ name, image, symbol })
        log("Creating token ...")
        const res = await createToken({
            name, symbol, url: url as any, image, decimals, website, initialMintingAmount: initialMinting
        }).catch(createTokenError => { log({ createTokenError }); return null })
        if (!res) {
            log("failed to create tx")
            return
        }
        if (res.Ok) {
            log("---- Token successfully minted ----")
            log("Tx Signature : ", res.Ok.txSignature)
            log("Token Address : ", res.Ok.tokenId)
        } else if (res.Err) {
            log(res.Err)
        }
    })
    .command('createmarket', 'create a market to create a pool', yargs => {
        return yargs.option('base', {
            alias: 'b',
            describe: "Base token address",
            type: "string",
            demandOption: "base token address must require"
        }).option('quote', {
            alias: 'q',
            describe: "Quote token address",
            type: "string",
            demandOption: "quore token address must require"
        }).option('order-size', {
            alias: 'os',
            describe: "Order size used to create market (default: 0.1)",
            type: "number",
            default: 0.1,
        }).option('price-tick', {
            alias: 'pt',
            describe: "Price tick used to create market (default: 0.1)",
            type: "number",
            default: 0.1,
        }).option("url", {
            alias: 'u',
            describe: "network type (devnet/mainnet) default (mainnet)",
            type: 'string',
            default: "mainnet"
        })
    }, async (args) => {
        const { orderSize, priceTick, url } = args
        let baseMint: web3.PublicKey | undefined | null = undefined
        let quoteMint: web3.PublicKey | undefined | null = undefined
        if (url != 'mainnet' && url != 'devnet') {
            log("please provide right url value ( 'mainnet' / 'devnet')")
            return
        }
        baseMint = getPubkeyFromStr(args.base)
        if (!baseMint) {
            log("Invalid base token address")
            return
        }
        quoteMint = getPubkeyFromStr(args.quote)
        if (!quoteMint) {
            log("Invalid quote token address")
            return
        }
        const res = await createMarket({ baseMint, orderSize, priceTick, quoteMint, url }).catch(createMarketError => { log({ createMarketError }); return null })
        if (!res) return log("failed to create pool")
        if (res.Err) return log({ error: res.Err })
        if (!res.Ok) return log("failed to create pool")
        const { marketId, txSignature } = res.Ok
        log("Transaction Successfully Executed:")
        log("Transaction Signature: ", txSignature)
        log("Market Address: ", marketId)
    })
    .command('createpool', 'create pool and add liquidity', yargs => {
        return yargs.option('market', {
            alias: 'm',
            describe: "Market id",
            type: "string",
            demandOption: "Market id must require"
        }).option('base-amount', {
            alias: 'ba',
            describe: "Initial base token liquidity",
            type: "number",
            demandOption: "base amount require"
        }).option('quote-amount', {
            alias: 'qa',
            describe: "Initial quote token liquidity",
            type: "number",
            demandOption: "quote amount require"
        }).option("url", {
            alias: 'u',
            describe: "network type (devnet/mainnet) default (mainnet)",
            type: 'string',
            default: "mainnet"
        })
    }, async (args) => {
        let { baseAmount, quoteAmount, orderSize, priceTick, url } = args
        orderSize = orderSize ?? 0.1;
        priceTick = priceTick ?? 0.1;
        let marketId: web3.PublicKey | undefined = undefined
        if (url != 'mainnet' && url != 'devnet') {
            log("Provide right url value ( 'mainnet' / 'devnet')")
            return
        }
        const id = getPubkeyFromStr(args.market)
        if (!id) {
            log("Invalid market id")
            return
        }
        marketId = id
        const res = await createPool({ marketId, baseMintAmount: baseAmount, quoteMintAmount: quoteAmount, url }).catch(error => { console.log({ createPoolError: error }); return null });
        if (!res) return log("failed to create pool")
        if (res.Err) return log({ error: res.Err })
        if (!res.Ok) return log("failed to create pool")
        const { poolId, txSignature } = res.Ok
        log("Pool creation transaction successfully:")
        log("transaction signature: ", txSignature)
        log("pool address: ", poolId)
    }).command('buy', 'buy token from pool', yargs => {
        return yargs.option("pool", {
            alias: 'p',
            describe: "Pool id",
            type: "string",
            demandOption: true
        }).option("buy-token", {
            alias: 'b',
            describe: "which token you want to buy (base / quote)",
            type: "string",
            demandOption: true
        }).option("amount", {
            alias: 'a',
            describe: "how many tokens you want to buy",
            type: "string",
            demandOption: true
        }).option("input-amount-type", {
            describe: "Which amount you want to input(`send` | `receive`)?",
            type: "string",
            default: "out"
        }).option("slippage", {
            alias: 's',
            describe: "slippage tolerance (default: 1%)",
            type: "number",
            default: 1
        }).option("url", {
            alias: 'u',
            describe: "solana network type (default: mainnet )(ex: mainnet / devnet)",
            type: "string",
            default: 'mainnet'
        })
    }, async (args) => {
        args.url = args.url
        args.poolId = args.poolId ?? ''
        const { buyToken, url, inputAmountType } = args
        if (url != 'mainnet' && url != 'devnet') return log("please enter valid url value")
        if (buyToken != 'base' && buyToken != 'quote') return log("buyToken args values should be 'base' or 'quote'")
        if (inputAmountType != 'send' && inputAmountType != 'receive') return log("Invalid input amount type")
        // const slippageAmount = Number(args.slipapge)
        const slippageAmount = args.slippage
        log({ slippageAmount })
        if (Number.isNaN(slippageAmount)) return log("Please enter valid slippage amount")
        const slippage = getSlippage(slippageAmount)
        const poolId = getPubkeyFromStr(args.pool.trim())
        if (!poolId) return log("Please enter valid pool address")
        const amount = Number((args.amount ?? "").trim())
        if (Number.isNaN(amount)) return log("Please enter valid amount")
        const txRes = await swap({ amount, amountSide: inputAmountType, buyToken, poolId, slippage, url }).catch(error => { console.log({ swapTxError: error }); return null })
        if (!txRes) return log("transaction failed")
        if (txRes.Err) return log({ Error: txRes.Err })
        if (!txRes.Ok) return log("transaction failed")
        log("--- Buy transaction successfull ---")
        log("Tx signature : ", txRes.Ok.txSignature)
    })
    .command('buysell', 'Buy and sell with bundle', yargs => {
        return yargs.option("pool", {
            alias: 'p',
            describe: "Pool id",
            type: "string",
            demandOption: true
        }).option("amount", {
            alias: 'a',
            describe: "how much amount you want to buy and sell",
            type: "string",
            demandOption: true
        }).option("input-amount-type", {
            describe: "Which amount you want to input(`base` | `quote`)?",
            type: "string",
            default: "base"
        }).option("first-buy", {
            describe: "which token will be buy and first and then sell (`base` | `quote`)",
            type: "string",
            default: "base"
        }).option("url", {
            alias: 'u',
            describe: "solana network type (default: mainnet )(ex: mainnet / devnet)",
            type: "string",
            default: 'mainnet'
        }).option("slippage", {
            alias: 's',
            describe: "slippage tolerance (default: 1%)",
            type: "number",
            default: 1
        })
    }, async args => {
        let { firstBuy, inputAmountType, pool, url } = args
        if (firstBuy != 'base' && firstBuy != 'quote') return log("invalid first buy input (required `base`|`quote`)")
        if (inputAmountType != 'base' && inputAmountType != 'quote') return log("invalid inputAmountType input (required `base`|`quote`)")
        const amount = Number(args.amount)
        if (!amount || Number.isNaN(amount)) return log("Invalid amount input ")
        const poolId = getPubkeyFromStr(pool)
        if (!poolId) return log("invalid pool id")
        if (url != 'mainnet' && url != 'devnet') return log("Invalid url values")
        const slippage = getSlippage(args.slippage)
        const res = await buySellWithBundle({ amount, amountTokenType: inputAmountType, firstBuyTokenType: firstBuy, poolId, url, slippage })
        log(res)
    }).command("addliquidity", "add liquidity in pool", yargs => {
        return yargs.option("pool", {
            alias: 'p',
            describe: "pool address",
            demandOption: "poolId require",
            type: 'string'
        }).option("amount", {
            alias: 'a',
            describe: "how much token you want to add (another token amount calcualted automatically)",
            demandOption: "reqire to enter amount",
            type: 'number'
        }).option("amount-side", {
            alias: 'as',
            describe: "which token amount you want to enter (base/quote)",
            demandOption: "reqire to enter amount size",
            type: 'string'
        }).option("slippage", {
            alias: 's',
            describe: "slippage tolerance",
            type: 'number',
            default: 1,
        }).option("url", {
            alias: 'u',
            describe: "solana network type (default: mainnet )(ex: mainnet / devnet)",
            type: "string",
            default: 'mainnet'
        })
    }, async (args) => {
        const { amount, amountSide, url } = args
        if (amountSide != 'base' && amountSide != 'quote') {
            return log("invalid amount side value")
        }
        if (url != 'mainnet' && url != 'devnet') {
            return log("invalid url value")
        }
        const poolId = getPubkeyFromStr(args.pool)
        if (!poolId) {
            log("Invalid pool id")
            return
        }
        const slippage = getSlippage(args.slippage)
        const res = await addLiquidity({ amount, amountSide, poolId, slippage, url }).catch(outerAddLiquidityError => {
            log({ outerAddLiquidityError })
            return null
        })
        if (!res) return log("failed to send the transaction")
        if (res.Err) return log({ error: res.Err })
        if (!res.Ok) return log("failed to send the transaction")
        log(`Add liquidity transaction successfull\nTx Signature: ${res.Ok.txSignature}`)
    }).command('removeliquidity', 'remove liquidity from the pool', yargs => {
        return yargs.option("pool", {
            alias: 'p',
            describe: "pool address",
            demandOption: "poolId require",
            type: 'string'
        }).option("amount", {
            alias: 'a',
            describe: "amount of lp tokens (enter -1 to remove all liquidity)",
            demandOption: "reqire to enter amount",
            type: 'number'
        }).option("url", {
            alias: 'u',
            describe: "solana network type (default: mainnet )(ex: mainnet / devnet)",
            type: "string",
            default: 'mainnet'
        })
    }, async (args) => {
        const { amount, url } = args
        if (url != 'mainnet' && url != 'devnet') {
            return log("invalid url value")
        }
        const poolId = getPubkeyFromStr(args.pool)
        if (!poolId) {
            log("Invalid pool id")
            return
        }
        const res = await removeLiquidity({ amount, poolId, url }).catch(outerRemoveLiquidityError => {
            log({ outerRemoveLiquidityError })
            return null
        })
        if (!res) return log("failed to send the transaction")
        if (res.Err) return log({ error: res.Err })
        if (!res.Ok) return log("failed to send the transaction")
        log(`Remove liquidity transaction successfull\nTx Signature: ${res.Ok.txSignature}`)
    }).command('unwrap', 'unwrap wrapped sol to normal sol', yargs => {
        return yargs.option('url', {
            alias: 'u',
            describe: "solana network type (default: mainnet )(ex: mainnet / devnet)",
            type: "string",
            default: 'mainnet'
        })
    }, async args => {
        log("unwrapping sol ...")
        const url = args.url
        if (url != 'mainnet' && url != 'devnet') return log("invalid url value")
        await unwrapSol(url)
    }).command('minting', 'token minting', yargs => {
        return yargs.option('token', {
            alias: 't',
            describe: "Token address",
            type: "string",
            demandOption: "token address require"
        }).option('amount', {
            alias: 'a',
            describe: "how many tokens to mint",
            type: 'number',
            demandOption: "token address require"
        }).option('url', {
            alias: 'u',
            describe: "solana network type (default: mainnet )(ex: mainnet / devnet)",
            type: "string",
            default: 'mainnet'
        })
    }, async args => {
        log("token minting ...")
        const url = args.url
        if (url != 'mainnet' && url != 'devnet') return log("invalid url value")
        const token = getPubkeyFromStr(args.token)
        if (!token) return log("Please enter valid token address")
        const amount = args.amount
        await mintTo({ token, amount, url })
    }).command("revokeauth", 'revoke token authority', yargs => {
        return yargs.option('token', {
            alias: 't',
            description: "Token address",
            type: 'string',
            demandOption: "token address must require"
        }).option('url', {
            alias: 'u',
            describe: "solana network type (default: mainnet )(ex: mainnet / devnet)",
            type: "string",
            default: 'mainnet'
        })
    }, async args => {
        const { url } = args
        const token = getPubkeyFromStr(args.token)
        if (!token) {
            log("Invalid token address")
            return
        }
        if (url != 'mainnet' && url != 'devnet') {
            log("Invalid url")
            return
        }
        await revokeAuthority({ token, url })
    }).command('create-and-buy', 'create pool and add liquidity', yargs => {
        return yargs.option('market', {
            alias: 'm',
            describe: "Market id",
            type: "string",
            demandOption: "Market id must require"
        }).option('base-amount', {
            alias: 'ba',
            describe: "Initial base token liquidity",
            type: "number",
            demandOption: "base amount require"
        }).option('quote-amount', {
            alias: 'qa',
            describe: "Initial quote token liquidity",
            type: "number",
            demandOption: "quote amount require"
        }).option("buy-token", {
            alias: 'bt',
            describe: "Which tokne you want to buy (base/quote) ?",
            type: 'string',
            default: "base"
        }).option("buy-amount", {
            describe: "how many token you want to buy instantly",
            type: 'number',
            demandOption: "buy amount require"
        }).option("url", {
            alias: 'u',
            describe: "network type (devnet/mainnet) default (mainnet)",
            type: 'string',
            default: "mainnet"
        })
    }, async (args) => {
        const { baseAmount, quoteAmount, market, buyToken, buyAmount, url } = args
        if (url != 'mainnet' && url != 'devnet') {
            log("Provide right url value ( 'mainnet' / 'devnet')")
            return
        }
        const marketId = getPubkeyFromStr(market)
        if (!marketId) {
            log("Invalid market id")
            return
        }
        if (buyToken != 'base' && buyToken != 'quote') {
            log("invalid buy token value (value should be `base` or `quote`")
            return
        }
        const res = await createAndBuy({
            marketId,
            baseMintAmount: baseAmount,
            quoteMintAmount: quoteAmount,
            buyToken,
            buyAmount,
            url
        }).catch((createAndBuyError) => {
            log({ createAndBuyError })
            return null
        })
        if (!res) {
            log("Failed to send bundle")
            return
        }
        if (res.Err) {
            const err = res.Err
            if (typeof err == 'string') return log(err)
            const { bundleId, poolId } = err
            log("Unable to verify the bundle transaction")
            log("please check it")
            log("Bundle id: ", bundleId)
            log("poolId: ", poolId)
            log(`Check the bundle here: https://explorer.jito.wtf/bundle/${bundleId}`)
            return
        }
        if (res.Ok) {
            const { bundleId, bundleStatus, buyTxSignature, createPoolTxSignature, poolId } = res.Ok
            log("Bundle send successfully")
            log("Bundle id: ", bundleId)
            log("Pool Id: ", poolId)
            log("Create pool transaction signature: ", createPoolTxSignature)
            log("Buy transaction signature: ", buyTxSignature)
            log(`Check the bundle here: https://explorer.jito.wtf/bundle/${bundleId}`)
            return
        }
        return log("Failed to send bundle")
    })
    .option('verbose', {
        alias: 'v',
        type: 'boolean',
        description: 'Run with verbose logging'
    })
    .parse();

