import { Wallet, web3 } from "@project-serum/anchor";
import { BaseMpl } from "./base/baseMpl";
import { Result } from "./base/types";
import { AddLiquidityInput, BundleRes, BuySellBunldeInput, CreateAndBuy, CreateMarketInput, CreatePoolInput, CreateTokenInput, RemoveLiquidityInput, SwapInput } from "./types";
import { calcDecimalValue, calcNonDecimalValue, deployJsonData, getKeypairFromEnv, getNthBuyerKeypair, getSecondKeypairFromEnv, sleep } from "./utils";
import { BUNDLE_FEE, ENV, RPC_ENDPOINT_DEV, RPC_ENDPOINT_MAIN } from "./constants";
import { BaseRay } from "./base/baseRay";
import { Metadata, NotAllowedToChangeSellerFeeBasisPointsError, TokenStandard } from "@metaplex-foundation/mpl-token-metadata";
import { AccountLayout, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { BaseSpl } from "./base/baseSpl";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { bundle } from "jito-ts";
import { Liquidity, LiquidityPoolInfo, Percent, SwapSide, Token, TokenAmount } from "@raydium-io/raydium-sdk";
import { BN } from "bn.js";
import { toBufferBE } from "bigint-buffer";
const log = console.log;
const confirmTransactionInitialTimeout = 100_000

const incTxFeeIx = web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 400_000 })
export async function createToken(input: CreateTokenInput): Promise<Result<{ tokenId: string, txSignature: string }, string>> {
    try {
        const { decimals, name, image, symbol, website, url, initialMintingAmount } = input;
        const metadata = {} as any
        if (image) metadata.image = image
        if (website) metadata.external_link = website
        // metadata.description = "Just a meme"
        const keypair = getKeypairFromEnv();
        const wallet = new Wallet(keypair)
        const endpoint = url == 'mainnet' ? RPC_ENDPOINT_MAIN : RPC_ENDPOINT_DEV
        const baseMpl = new BaseMpl(wallet, { endpoint })
        let ipfsHash = "Null"

        if (ENV.IN_PRODUCTION) {
            const hash = await deployJsonData(metadata).catch(() => null)
            if (!hash) {
                return { Err: "failed to deploy json metadata" }
            }
            ipfsHash = hash
        }
        if (!ipfsHash) throw "Failed to deploy metadata"
        const uri = `https://${ENV.PINATA_DOMAIN}/ipfs/${ipfsHash}`;
        const res = await baseMpl.createToken({
            name, uri,
            symbol,
            sellerFeeBasisPoints: 0,
            tokenStandard: TokenStandard.Fungible,
            creators: [{ address: wallet.publicKey, share: 100 }]
        }, { decimal: decimals, mintAmount: initialMintingAmount ?? 0 })
        if (!res) {
            return { Err: "Failed to send the transation" }
        }
        return {
            Ok: {
                txSignature: res.txSignature,
                tokenId: res.token
            }
        }
    }
    catch (error) {
        log({ error })
        return { Err: "failed to create the token" }
    }
}

export async function addLiquidity(input: AddLiquidityInput): Promise<Result<{ txSignature: string }, string>> {
    const { amount, amountSide, poolId, url, slippage } = input
    const keypair = getKeypairFromEnv();
    const user = keypair.publicKey
    const connection = new web3.Connection(input.url == 'mainnet' ? RPC_ENDPOINT_MAIN : RPC_ENDPOINT_DEV, { confirmTransactionInitialTimeout })
    const baseRay = new BaseRay({ rpcEndpointUrl: connection.rpcEndpoint })
    const poolKeys = await baseRay.getPoolKeys(poolId).catch(getPoolKeysError => { log({ getPoolKeysError }); return null })
    if (!poolKeys) return { Err: "Pool not found" }
    const amountInfo = await baseRay.computeAnotherAmount({ amount, fixedSide: amountSide, poolKeys, isRawAmount: false, slippage }).catch(computeAnotherAmountError => { log({ computeAnotherAmount: computeAnotherAmountError }); return null })
    if (!amountInfo) return { Err: "Failed to clculate the amount" }
    const { baseMintAmount, liquidity, quoteMintAmount, } = amountInfo
    const txInfo = await baseRay.addLiquidity({ baseMintAmount, fixedSide: amountSide, poolKeys, quoteMintAmount, user }).catch(addLiquidityError => { log({ addLiquidityError }); return null })
    if (!txInfo) return { Err: 'failed to prepare tx' }
    const tx = new web3.Transaction().add(incTxFeeIx, ...txInfo.ixs)
    tx.feePayer = user
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash
    tx.recentBlockhash = recentBlockhash
    tx.sign(keypair)
    const rawTx = tx.serialize()
    // const res = await connection.sendTransaction(tx).catch(sendTxError => { log({ sendTxError }); return null });
    const txSignature = await web3.sendAndConfirmRawTransaction(connection, Buffer.from(rawTx), { commitment: 'confirmed' })
        .catch(async (txSendError) => {
            log({ txSendError })
            return null
        })
    if (!txSignature) return { Err: "failed to send the transaction" }
    return { Ok: { txSignature } }
}

export async function removeLiquidity(input: RemoveLiquidityInput): Promise<Result<{ txSignature: string }, string>> {
    const { amount, poolId, url, } = input
    const keypair = getKeypairFromEnv();
    const user = keypair.publicKey
    log({ user: user.toBase58() })
    const connection = new web3.Connection(input.url == 'mainnet' ? RPC_ENDPOINT_MAIN : RPC_ENDPOINT_DEV, { confirmTransactionInitialTimeout })
    const baseRay = new BaseRay({ rpcEndpointUrl: connection.rpcEndpoint })
    const poolKeys = await baseRay.getPoolKeys(poolId).catch(getPoolKeysError => { log({ getPoolKeysError }); return null })
    if (!poolKeys) return { Err: "Pool not found" }
    const txInfo = await baseRay.removeLiquidity({ amount, poolKeys, user }).catch(removeLiquidityError => { log({ removeLiquidityError }); return null })
    if (!txInfo) return { Err: "failed to prepare tx" }
    if (txInfo.Err) return { Err: txInfo.Err }
    if (!txInfo.Ok) return { Err: "failed to prepare tx" }
    const ixs = txInfo.Ok.ixs
    const updateCuIx = web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ENV.COMPUTE_UNIT_PRICE })
    const tx = new web3.Transaction().add(updateCuIx, ...ixs)
    tx.feePayer = user
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.recentBlockhash = recentBlockhash
    tx.sign(keypair)

    if (input.quick) {
        const handlers: Promise<void>[] = []
        for (let i = 0; i < 2; ++i) {
            const handle = connection.sendTransaction(tx, [keypair], { skipPreflight: true }).catch(sendTxError => { return null }).then((res) => {
                if (res) {
                    log(`try: ${i + 1} | txSignature: ${res}`)
                }
            });
            handlers.push(handle)
        }
        for (let h of handlers) {
            await h
        }
    }

    const rawTx = tx.serialize()
    const txSignature = (await web3.sendAndConfirmRawTransaction(connection, Buffer.from(rawTx), { commitment: 'confirmed' })
        .catch(async (txError) => {
            log({ txError })
            return null
        }))
    if (!txSignature) return { Err: "failed to send the transaction" }
    return { Ok: { txSignature } }
}

export async function createMarket(input: CreateMarketInput): Promise<Result<{ marketId: string, txSignature: string }, string>> {
    const { baseMint, orderSize, priceTick, quoteMint, url } = input
    const keypair = getKeypairFromEnv();
    const connection = new web3.Connection(input.url == 'mainnet' ? RPC_ENDPOINT_MAIN : RPC_ENDPOINT_DEV, { confirmTransactionInitialTimeout })
    const cuHighIx = web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 400_000 })
    log({ baseMint: baseMint.toBase58(), quoteMint: quoteMint.toBase58() })
    const baseRay = new BaseRay({ rpcEndpointUrl: connection.rpcEndpoint })
    const preTxInfo = await baseRay.createMarket({ baseMint, quoteMint, tickers: { lotSize: orderSize, tickSize: priceTick } }, keypair.publicKey).catch(createMarketError => { return null })
    if (!preTxInfo) {
        return { Err: "Failed to prepare market creation transaction" }
    }
    if (preTxInfo.Err) {
        return { Err: preTxInfo.Err }
    }
    if (!preTxInfo.Ok) return { Err: "failed to prepare tx" }
    const { marketId } = preTxInfo.Ok
    try {
        const payer = keypair.publicKey
        const info = preTxInfo.Ok
        const tx1 = new web3.Transaction().add(cuHighIx, ...info.vaultInstructions)
        tx1.feePayer = payer
        // const txSignature1 = await connection.sendTransaction(tx1, [keypair, ...info.vaultSigners])
        const txSignature1 = await web3.sendAndConfirmTransaction(connection, tx1, [keypair, ...info.vaultSigners])
        await sleep(5_000)
        const tx2 = new web3.Transaction().add(cuHighIx, ...info.marketInstructions)
        tx2.feePayer = payer
        const txSignature = await connection.sendTransaction(tx2, [keypair, ...info.marketSigners], { skipPreflight: true })
        await sleep(15_000)
        const accountInfo = await connection.getAccountInfo(info.marketId)
        if (!accountInfo) {
            await sleep(10_000)
            const accountInfo = await connection.getAccountInfo(info.marketId)
            if (!accountInfo) {
                return {
                    Err: `Failed to verify market creation. marketId: ${marketId.toBase58()}`
                }
            }
        }
        return {
            Ok: {
                marketId: marketId.toBase58(),
                txSignature: txSignature
            }
        }
    } catch (error) {
        log({ error })
        return { Err: "failed to send the transaction" }
    }
}

export async function createPool(input: CreatePoolInput): Promise<Result<{ poolId: string, txSignature: string }, string>> {
    let { baseMintAmount, quoteMintAmount, marketId } = input
    const keypair = getKeypairFromEnv();
    const connection = new web3.Connection(input.url == 'mainnet' ? RPC_ENDPOINT_MAIN : RPC_ENDPOINT_DEV, { confirmTransactionInitialTimeout })
    const baseRay = new BaseRay({ rpcEndpointUrl: connection.rpcEndpoint })
    const marketState = await baseRay.getMarketInfo(marketId).catch((getMarketInfoError) => { log({ getMarketInfoError }); return null })
    // log({marketState})
    if (!marketState) {
        return { Err: "market not found" }
    }
    const { baseMint, quoteMint } = marketState
    log({
        baseToken: baseMint.toBase58(),
        quoteToken: quoteMint.toBase58(),
    })
    const txInfo = await baseRay.createPool({ baseMint, quoteMint, marketId, baseMintAmount, quoteMintAmount }, keypair.publicKey).catch((innerCreatePoolError) => { log({ innerCreatePoolError }); return null })
    if (!txInfo) return { Err: "Failed to prepare create pool transaction" }
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const txMsg = new web3.TransactionMessage({
        instructions: [incTxFeeIx, ...txInfo.ixs],
        payerKey: keypair.publicKey,
        recentBlockhash,
    }).compileToV0Message()
    const tx = new web3.VersionedTransaction(txMsg)
    tx.sign([keypair, ...txInfo.signers])
    const rawTx = tx.serialize()
    const txSignature = (await web3.sendAndConfirmRawTransaction(connection, Buffer.from(rawTx), { commitment: 'confirmed' })
        .catch(async (txError) => {
            log({ txError })
            return null
        }))
    if (!txSignature) log("Tx failed")
    // const txSignature = await connection.sendTransaction(tx).catch((error) => { log({ createPoolTxError: error }); return null });
    if (!txSignature) {
        return { Err: "Failed to send transaction" }
    }
    return {
        Ok: {
            poolId: txInfo.poolId.toBase58(),
            txSignature,
        }
    }
}

export async function buySellWithBundle(input: BuySellBunldeInput) {
    const keypair = getNthBuyerKeypair(1);
    const user = keypair.publicKey
    const connection = new web3.Connection(input.url == 'mainnet' ? RPC_ENDPOINT_MAIN : RPC_ENDPOINT_DEV, { confirmTransactionInitialTimeout })
    const baseRay = new BaseRay({ rpcEndpointUrl: connection.rpcEndpoint })
    const slippage = input.slippage
    const poolKeys = await baseRay.getPoolKeys(input.poolId).catch(getPoolKeysError => { log({ getPoolKeysError }); return null })
    if (!poolKeys) { return { Err: "Pool info not found" } }
    log({
        baseToken: poolKeys.baseMint.toBase58(),
        quoteToken: poolKeys.quoteMint.toBase58(),
    })
    const { baseDecimals, quoteDecimals, baseMint, quoteMint } = poolKeys
    let { amountTokenType, firstBuyTokenType } = input
    // const amount = calcNonDecimalValue(input.amount, amountTokenType == 'base' ? baseDecimals : quoteDecimals)
    const userBaseAta = getAssociatedTokenAddressSync(baseMint, user)
    const userQuoteAta = getAssociatedTokenAddressSync(quoteMint, user)
    const [lpAccountInfo, baseVAccountInfo, quoteVAccountInfo, baseAtaInfo, quoteAtaInfo] = await connection.getMultipleAccountsInfo([poolKeys.lpMint, poolKeys.baseVault, poolKeys.quoteVault, userBaseAta, userQuoteAta].map((e) => new web3.PublicKey(e)))
    if (!lpAccountInfo || !baseVAccountInfo || !quoteVAccountInfo) throw "Failed to fetch some data"
    let lpSupply = new BN(toBufferBE(MintLayout.decode(lpAccountInfo.data).supply, 8))
    let baseReserve = new BN(toBufferBE(AccountLayout.decode(baseVAccountInfo.data).amount, 8))
    let quoteReserve = new BN(toBufferBE(AccountLayout.decode(quoteVAccountInfo.data).amount, 8))
    const poolInfo: LiquidityPoolInfo = {
        baseDecimals: poolKeys.baseDecimals,
        quoteDecimals: poolKeys.quoteDecimals,
        lpDecimals: poolKeys.lpDecimals,
        lpSupply,
        baseReserve,
        quoteReserve,
        startTime: null as any,
        status: null as any
    }
    let preIxs: web3.TransactionInstruction[] = []
    if (!baseAtaInfo) {
        preIxs.push(createAssociatedTokenAccountInstruction(user, userBaseAta, user, baseMint))
    }
    if (!quoteAtaInfo) {
        preIxs.push(createAssociatedTokenAccountInstruction(user, userQuoteAta, user, quoteMint))
    }
    let txs: web3.VersionedTransaction[] = []
    {
        let inToken: Token;
        let outToken: Token;
        let outTokenDecimal;
        let inTokenDecimal;
        let tokenAccountIn: web3.PublicKey
        let tokenAccountOut: web3.PublicKey
        let amountIn: TokenAmount;
        let amountOut: TokenAmount;
        let fixedSide: SwapSide
        let _inAmount: TokenAmount
        let _outAmount: TokenAmount
        if (firstBuyTokenType == 'base') {
            outToken = new Token(TOKEN_PROGRAM_ID, baseMint, baseDecimals);
            inToken = new Token(TOKEN_PROGRAM_ID, quoteMint, quoteDecimals);
            outTokenDecimal = baseDecimals;
            inTokenDecimal = quoteDecimals;
            tokenAccountIn = getAssociatedTokenAddressSync(quoteMint, user)
            tokenAccountOut = getAssociatedTokenAddressSync(baseMint, user)
            amountTokenType == 'base' ? fixedSide = 'out' : fixedSide = 'in'
        } else {
            outToken = new Token(TOKEN_PROGRAM_ID, quoteMint, quoteDecimals);
            inToken = new Token(TOKEN_PROGRAM_ID, baseMint, baseDecimals);
            outTokenDecimal = quoteDecimals;
            inTokenDecimal = quoteDecimals;
            tokenAccountOut = getAssociatedTokenAddressSync(quoteMint, user)
            tokenAccountIn = getAssociatedTokenAddressSync(baseMint, user)
            amountTokenType == 'base' ? fixedSide = 'in' : fixedSide = 'out'
        }
        const currentBaseLiquidity = Number(poolInfo.baseReserve.toString());
        const currentQuoteLiquidity = Number(poolInfo.quoteReserve.toString());
        if (fixedSide == 'in') {
            amountIn = new TokenAmount(inToken, input.amount.toString(), false);
            const out = Liquidity.computeAmountOut({
                amountIn,
                currencyOut: outToken,
                poolInfo,
                poolKeys,
                slippage,
            })
            amountOut = out.minAmountOut as TokenAmount
            _inAmount = amountIn
            _outAmount = out.amountOut as TokenAmount
        } else {
            amountOut = new TokenAmount(outToken, input.amount.toString(), false);
            const innn = Liquidity.computeAmountIn({
                amountOut,
                currencyIn: inToken,
                poolInfo,
                poolKeys,
                slippage
            })
            amountIn = innn.maxAmountIn as TokenAmount
            _inAmount = innn.amountIn as TokenAmount
            _outAmount = amountOut
        }
        const buyInfo = await baseRay.buyFromPool({
            amountIn, amountOut, fixedSide, poolKeys, tokenAccountIn, tokenAccountOut, user, skipAtaInit: true
        }).catch((buyFromPoolError) => {
            log({ buyFromPoolError })
            return null
        })
        if (!buyInfo) throw "Failed to prepare tx"
        const recentBlockhash = (await connection.getLatestBlockhash().catch(async () => {
            await sleep(1_000)
            return await connection.getLatestBlockhash().catch(() => null)
        }))?.blockhash
        if (!recentBlockhash) throw "blockhash not found"
        const msg = new web3.TransactionMessage({
            instructions: [...preIxs, ...buyInfo.ixs],
            payerKey: user,
            recentBlockhash,
        }).compileToV0Message()
        const tx = new web3.VersionedTransaction(msg)
        tx.sign([keypair])
        txs.push(tx)
        if (_inAmount.token.mint.toBase58() == quoteMint.toBase58()) {
            poolInfo.quoteReserve = new BN(
                toBufferBE(
                    BigInt(
                        (
                            currentQuoteLiquidity + Number(_inAmount.raw.toString())
                        ).toString()
                    ),
                    8
                )
            );
            poolInfo.baseReserve = new BN(
                toBufferBE(
                    BigInt(
                        (
                            currentBaseLiquidity - Number(_outAmount.raw.toString())
                        ).toString()
                    ),
                    8
                )
            );
        } else {
            poolInfo.baseReserve = new BN(
                toBufferBE(
                    BigInt(
                        (
                            currentBaseLiquidity + Number(_inAmount.raw.toString())
                        ).toString()
                    ),
                    8
                )
            );
            poolInfo.quoteReserve = new BN(
                toBufferBE(
                    BigInt(
                        (
                            currentQuoteLiquidity - Number(_outAmount.raw.toString())
                        ).toString()
                    ),
                    8
                )
            );
        }
    }

    await sleep(2_000)
    firstBuyTokenType = firstBuyTokenType == 'base' ? 'quote' : 'base'
    {
        let inToken: Token;
        let outToken: Token;
        let outTokenDecimal;
        let inTokenDecimal;
        let tokenAccountIn: web3.PublicKey
        let tokenAccountOut: web3.PublicKey
        let amountIn: TokenAmount;
        let amountOut: TokenAmount;
        let fixedSide: SwapSide
        let _inAmount: TokenAmount
        let _outAmount: TokenAmount
        if (firstBuyTokenType == 'base') {
            outToken = new Token(TOKEN_PROGRAM_ID, baseMint, baseDecimals);
            inToken = new Token(TOKEN_PROGRAM_ID, quoteMint, quoteDecimals);
            outTokenDecimal = baseDecimals;
            inTokenDecimal = quoteDecimals;
            tokenAccountIn = getAssociatedTokenAddressSync(quoteMint, user)
            tokenAccountOut = getAssociatedTokenAddressSync(baseMint, user)
            amountTokenType == 'base' ? fixedSide = 'out' : fixedSide = 'in'
        } else {
            outToken = new Token(TOKEN_PROGRAM_ID, quoteMint, quoteDecimals);
            inToken = new Token(TOKEN_PROGRAM_ID, baseMint, baseDecimals);
            outTokenDecimal = quoteDecimals;
            inTokenDecimal = quoteDecimals;
            tokenAccountOut = getAssociatedTokenAddressSync(quoteMint, user)
            tokenAccountIn = getAssociatedTokenAddressSync(baseMint, user)
            amountTokenType == 'base' ? fixedSide = 'in' : fixedSide = 'out'
        }
        const currentBaseLiquidity = Number(poolInfo.baseReserve.toString());
        const currentQuoteLiquidity = Number(poolInfo.quoteReserve.toString());
        if (fixedSide == 'in') {
            amountIn = new TokenAmount(inToken, input.amount.toString(), false);
            const out = Liquidity.computeAmountOut({
                amountIn,
                currencyOut: outToken,
                poolInfo,
                poolKeys,
                slippage,
            })
            amountOut = out.minAmountOut as TokenAmount
            _inAmount = amountIn
            _outAmount = out.amountOut as TokenAmount
        } else {
            amountOut = new TokenAmount(outToken, input.amount.toString(), false);
            const innn = Liquidity.computeAmountIn({
                amountOut,
                currencyIn: inToken,
                poolInfo,
                poolKeys,
                slippage
            })
            amountIn = innn.maxAmountIn as TokenAmount
            _inAmount = innn.amountIn as TokenAmount
            _outAmount = amountOut
        }
        const buyInfo = await baseRay.buyFromPool({
            amountIn, amountOut, fixedSide, poolKeys, tokenAccountIn, tokenAccountOut, user, skipAtaInit: true
        }).catch((buyFromPoolError) => {
            log({ buyFromPoolError })
            return null
        })
        if (!buyInfo) throw "Failed to prepare tx"
        const recentBlockhash = (await connection.getLatestBlockhash().catch(async () => {
            await sleep(1_000)
            return await connection.getLatestBlockhash().catch(() => null)
        }))?.blockhash
        if (!recentBlockhash) throw "blockhash not found"
        const msg = new web3.TransactionMessage({
            instructions: buyInfo.ixs,
            payerKey: user,
            recentBlockhash,
        }).compileToV0Message()
        const tx = new web3.VersionedTransaction(msg)
        tx.sign([keypair])
        txs.push(tx)
        if (_inAmount.token.mint.toBase58() == quoteMint.toBase58()) {
            poolInfo.quoteReserve = new BN(
                toBufferBE(
                    BigInt(
                        (
                            currentQuoteLiquidity + Number(_inAmount.raw.toString())
                        ).toString()
                    ),
                    8
                )
            );
            poolInfo.baseReserve = new BN(
                toBufferBE(
                    BigInt(
                        (
                            currentBaseLiquidity - Number(_outAmount.raw.toString())
                        ).toString()
                    ),
                    8
                )
            );
        } else {
            poolInfo.baseReserve = new BN(
                toBufferBE(
                    BigInt(
                        (
                            currentBaseLiquidity + Number(_inAmount.raw.toString())
                        ).toString()
                    ),
                    8
                )
            );
            poolInfo.quoteReserve = new BN(
                toBufferBE(
                    BigInt(
                        (
                            currentQuoteLiquidity - Number(_outAmount.raw.toString())
                        ).toString()
                    ),
                    8
                )
            );
        }
    }

    if (input.url == 'devnet') {
        const txRes1 = await connection.sendRawTransaction(Buffer.from(txs[0].serialize()), { skipPreflight: true }).catch((txError) => {
            log({ txError })
            return null
        })
        log({ txRes1 })

        await sleep(3_000)
        const txRes2 = await connection.sendRawTransaction(Buffer.from(txs[1].serialize()), { skipPreflight: true }).catch((txError) => {
            log({ txError })
            return null
        })
        log({ txRes2 })
    }

    else {
        // BUNDLE 
        const bundleRes = await sendBundle(txs, keypair, BUNDLE_FEE, connection,).catch(() => null)
        if (!bundleRes) throw "bundle send may failed"
        log({ bundleRes })
    }
}

export async function swap(input: SwapInput): Promise<Result<{ txSignature: string }, string>> {
    const keypair = getKeypairFromEnv();
    const user = keypair.publicKey
    const connection = new web3.Connection(input.url == 'mainnet' ? RPC_ENDPOINT_MAIN : RPC_ENDPOINT_DEV, { confirmTransactionInitialTimeout })
    const baseRay = new BaseRay({ rpcEndpointUrl: connection.rpcEndpoint })
    const slippage = input.slippage
    const poolKeys = await baseRay.getPoolKeys(input.poolId).catch(getPoolKeysError => { log({ getPoolKeysError }); return null })
    if (!poolKeys) { return { Err: "Pool info not found" } }
    log({
        baseToken: poolKeys.baseMint.toBase58(),
        quoteToken: poolKeys.quoteMint.toBase58(),
    })
    const { amount, amountSide, buyToken, } = input
    const swapAmountInfo = await baseRay.computeBuyAmount({
        amount, buyToken, inputAmountType: amountSide, poolKeys, user, slippage
    }).catch((computeBuyAmountError => log({ computeBuyAmountError })))
    if (!swapAmountInfo) return { Err: "failed to calculate the amount" }
    const { amountIn, amountOut, fixedSide, tokenAccountIn, tokenAccountOut, } = swapAmountInfo
    const txInfo = await baseRay.buyFromPool({ amountIn, amountOut, fixedSide, poolKeys, tokenAccountIn, tokenAccountOut, user }).catch(buyFromPoolError => { log({ buyFromPoolError }); return null })
    if (!txInfo) return { Err: "failed to prepare swap transaction" }
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const txMsg = new web3.TransactionMessage({
        instructions: [incTxFeeIx, ...txInfo.ixs],
        payerKey: keypair.publicKey,
        recentBlockhash,
    }).compileToV0Message()
    const tx = new web3.VersionedTransaction(txMsg)
    tx.sign([keypair, ...txInfo.signers])
    const rawTx = tx.serialize()
    const txSignature = (await web3.sendAndConfirmRawTransaction(connection, Buffer.from(rawTx), { commitment: 'confirmed' })
        .catch(async (txError) => {
            log({ txError })
            return null
        }))
    if (!txSignature) {
        return { Err: "Failed to send transaction" }
    }
    return {
        Ok: {
            txSignature,
        }
    }
}

export async function unwrapSol(url: 'mainnet' | 'devnet') {
    const keypair = getKeypairFromEnv();
    const user = keypair.publicKey
    const connection = new web3.Connection(url == 'mainnet' ? RPC_ENDPOINT_MAIN : RPC_ENDPOINT_DEV, { confirmTransactionInitialTimeout })
    const ata = getAssociatedTokenAddressSync(NATIVE_MINT, user)
    const ix = createCloseAccountInstruction(ata, user, user)
    const updateCuIx = web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ENV.COMPUTE_UNIT_PRICE })
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const tx = new web3.Transaction().add(updateCuIx, ix)
    tx.feePayer = user
    tx.recentBlockhash = recentBlockhash
    tx.sign(keypair)
    const rawTx = tx.serialize()
    const txSignature = (await web3.sendAndConfirmRawTransaction(connection, Buffer.from(rawTx), { commitment: 'confirmed' })
        .catch(async (txError) => {
            log({ txError })
            return null
        }))
    if (!txSignature) log("Tx failed")
    log("Transaction successfull\nTx Signature: ", txSignature)
}

export async function mintTo(input: { token: web3.PublicKey, amount: number, url: 'mainnet' | 'devnet' }) {
    const { token, url, amount } = input
    const keypair = getKeypairFromEnv();
    const user = keypair.publicKey
    const connection = new web3.Connection(url == 'mainnet' ? RPC_ENDPOINT_MAIN : RPC_ENDPOINT_DEV, { confirmTransactionInitialTimeout })
    const baseSpl = new BaseSpl(connection)
    const ixs = await baseSpl.getMintToInstructions({ mint: token, mintAuthority: user, amount, init_if_needed: true })
    const tx = new web3.Transaction().add(incTxFeeIx, ...ixs)
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = user
    tx.recentBlockhash = recentBlockhash
    tx.sign(keypair)
    const rawTx = tx.serialize()
    const txSignature = (await web3.sendAndConfirmRawTransaction(connection, Buffer.from(rawTx), { commitment: 'confirmed' })
        .catch(async (txError) => {
            log({ txError })
            return null
        }))
    if (!txSignature) log("Tx failed")
    log("Transaction successfull\nTx Signature: ", txSignature)
}

export async function revokeAuthority(input: { token: web3.PublicKey, url: 'mainnet' | 'devnet' }) {
    const { token, url } = input;
    const keypair = getKeypairFromEnv();
    const user = keypair.publicKey
    const wallet = new Wallet(keypair)
    const connection = new web3.Connection(url == 'mainnet' ? RPC_ENDPOINT_MAIN : RPC_ENDPOINT_DEV, { confirmTransactionInitialTimeout })
    const baseSpl = new BaseSpl(connection)
    const baseMpl = new BaseMpl(wallet, { endpoint: connection.rpcEndpoint })
    const [mintAccountInfo, metadataAccountInfo] = await connection.getMultipleAccountsInfo([token, BaseMpl.getMetadataAccount(token)]).catch(error => [null, null])
    if (!mintAccountInfo) {
        log("Token not found")
        return
    }
    const cuHighIx = web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 400_000 })
    const ixs: web3.TransactionInstruction[] = [cuHighIx]
    const mintInfo = MintLayout.decode(mintAccountInfo.data);
    if (mintInfo.mintAuthority.toBase58() == user.toBase58() && mintInfo.mintAuthorityOption == 1) {
        ixs.push(baseSpl.revokeAuthority({ authorityType: 'MINTING', currentAuthority: user, mint: token }))
    } else {
        if (mintInfo.mintAuthorityOption == 0) {
            log("Minting authority already been revoked")
        } else {
            log("You don't have minting authority")
        }
    }
    if (mintInfo.freezeAuthority.toBase58() == user.toBase58() && mintInfo.freezeAuthorityOption == 1) {
        ixs.push(baseSpl.revokeAuthority({ authorityType: 'FREEZING', currentAuthority: user, mint: token }))
    } else {
        if (mintInfo.freezeAuthorityOption == 0) {
            log("Freezing authority already been revoked")
        } else {
            log("You don't have freezing authority")
        }
    }
    if (metadataAccountInfo) {
        const metadataInfo = Metadata.deserialize(metadataAccountInfo.data)[0]
        const metadataUpdateAuthStr = metadataInfo.updateAuthority.toBase58();
        if (metadataUpdateAuthStr == user.toBase58() && metadataInfo.isMutable) {
            ixs.push(baseMpl.getRevokeMetadataAuthIx(token, user))
        } else if (!metadataInfo.isMutable) {
            log('Update authority already been revoked')
        } else {
            log("You don't have metadata update authority")
        }
    }
    if (ixs.length == 0) {
        log("All authority are revoked")
        return
    }
    const tx = new web3.Transaction().add(...ixs)
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = user
    tx.recentBlockhash = recentBlockhash
    tx.sign(keypair)
    const rawTx = tx.serialize()
    const txSignature = (await web3.sendAndConfirmRawTransaction(connection, Buffer.from(rawTx), { commitment: 'confirmed' })
        .catch(async (txError) => {
            log({ txError })
            return null
        }))
    if (!txSignature) log("Tx failed")
    log("Transaction successfull\nTx Signature: ", txSignature)
}


export async function createAndBuy(input: CreateAndBuy): Promise<Result<{
    bundleId: string;
    poolId: string;
    createPoolTxSignature: string;
    buyTxSignature: string;
    bundleStatus: number;
}, { bundleId: string, poolId: string } | string>> {
    let { baseMintAmount, quoteMintAmount, marketId } = input
    const poolCreatorAuthority = getKeypairFromEnv();
    const poolCreator = poolCreatorAuthority.publicKey
    const buyerAuthority = getSecondKeypairFromEnv();
    const buyer = buyerAuthority.publicKey
    if (poolCreator.toBase58() == buyer.toBase58()) { return { Err: "Creator and buyer Wallet should be different" } }
    const connection = new web3.Connection(input.url == 'mainnet' ? RPC_ENDPOINT_MAIN : RPC_ENDPOINT_DEV, { confirmTransactionInitialTimeout })
    const baseRay = new BaseRay({ rpcEndpointUrl: connection.rpcEndpoint })
    const marketState = await baseRay.getMarketInfo(marketId).catch((getMarketInfoError) => { log({ getMarketInfoError }); return null })
    if (!marketState) {
        return { Err: "market not found" }
    }
    const { baseMint, quoteMint } = marketState
    log({
        baseToken: baseMint.toBase58(),
        quoteToken: quoteMint.toBase58(),
    })
    const createPoolTxInfo = await baseRay.createPool({ baseMint, quoteMint, marketId, baseMintAmount, quoteMintAmount }, poolCreatorAuthority.publicKey).catch((innerCreatePoolError) => { log({ innerCreatePoolError }); return null })
    if (!createPoolTxInfo) return { Err: "Failed to prepare create pool transaction" }
    let createPoolSolFund = 0;
    if (baseMint.toBase58() == NATIVE_MINT.toBase58() || quoteMint.toBase58() == NATIVE_MINT.toBase58()) {
        const { baseAmount, quoteAmount } = createPoolTxInfo
        if (baseMint.toBase58() == NATIVE_MINT.toBase58()) {
            createPoolSolFund = Number(baseAmount.toString())
        } else {
            createPoolSolFund = Number(quoteAmount.toString())
        }
    }

    //buy
    const { poolId, baseAmount: initialBaseMintAmount, quoteAmount: initialQuoteMintAmount } = createPoolTxInfo;
    const poolKeys = await baseRay.getPoolKeys(poolId)
    let amountIn: TokenAmount
    let amountOut: TokenAmount
    let tokenAccountIn: web3.PublicKey
    let tokenAccountOut: web3.PublicKey
    const baseR = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals)
    const quoteR = new Token(TOKEN_PROGRAM_ID, poolKeys.quoteMint, poolKeys.quoteDecimals)
    const poolInfo: LiquidityPoolInfo = {
        baseDecimals: poolKeys.baseDecimals,
        quoteDecimals: poolKeys.quoteDecimals,
        lpDecimals: poolKeys.lpDecimals,
        lpSupply: new BN(0),
        baseReserve: initialBaseMintAmount,
        quoteReserve: initialQuoteMintAmount,
        startTime: null as any,
        status: null as any
    }
    const { buyToken: buyTokenType, buyAmount } = input
    const preBuyIxs: web3.TransactionInstruction[] = []
    if (buyTokenType == 'base') {
        amountOut = new TokenAmount(baseR, buyAmount.toString(), false)
        amountIn = Liquidity.computeAmountIn({ amountOut, currencyIn: quoteR, poolInfo, poolKeys, slippage: new Percent(1, 100) }).maxAmountIn as TokenAmount
        tokenAccountOut = getAssociatedTokenAddressSync(poolKeys.baseMint, buyer)
        tokenAccountIn = getAssociatedTokenAddressSync(poolKeys.quoteMint, buyer)
        const infos = await connection.getMultipleAccountsInfo([poolCreator, buyer, tokenAccountIn, tokenAccountOut]).catch(async () => {
            await sleep(2_000)
            return await connection.getMultipleAccountsInfo([poolCreator, buyer, tokenAccountIn, tokenAccountOut]).catch((getMultipleAccountsInfoError) => {
                log({ getMultipleAccountsInfoError })
                return null
            })
        })
        if (!infos) return { Err: "Failed to prepare buy transaction" }
        const [poolCreatorAccountInfo, buyerAccountInfo, buyerInAtaInfo, buyerOutAtaInfo] = infos
        if (!poolCreatorAccountInfo) return { Err: "pool creator wallet dosen't have enought Sol to create pool" }
        const creatorBalance = poolCreatorAccountInfo.lamports
        if (creatorBalance < createPoolSolFund) return { Err: "pool creator wallet dosen't have enought Sol to create pool" }
        if (!buyerAccountInfo) return { Err: "buyer wallet dosen't have enought Sol to create pool" }
        const buyerBalance = calcDecimalValue(buyerAccountInfo.lamports, 9)
        let minRequiredBuyerBalance = 0
        if (amountIn.token.mint.toBase58() == NATIVE_MINT.toBase58()) {
            minRequiredBuyerBalance += calcDecimalValue(amountIn.raw.toNumber(), 9)
            if (buyerBalance < minRequiredBuyerBalance) return { Err: "Buyer wallet dosen't have enought Sol to buy the tokens" }
        } else {
            if (!buyerInAtaInfo) return { Err: "buyer wallet dosen't have enought fund to buy another token" }
            const tokenBalance = Number(AccountLayout.decode(buyerInAtaInfo.data).amount.toString())
            if (tokenBalance < amountIn.raw.toNumber()) {
                return { Err: "buyer wallet dosen't have enought fund to buy another token" }
            }
        }
        if (!buyerInAtaInfo) preBuyIxs.push(createAssociatedTokenAccountInstruction(buyer, tokenAccountIn, buyer, amountIn.token.mint))
        if (!buyerOutAtaInfo) preBuyIxs.push(createAssociatedTokenAccountInstruction(buyer, tokenAccountOut, buyer, amountOut.token.mint))
    } else {
        amountOut = new TokenAmount(quoteR, buyAmount.toString(), false)
        amountIn = Liquidity.computeAmountIn({ amountOut, currencyIn: baseR, poolInfo, poolKeys, slippage: new Percent(1, 100) }).maxAmountIn as TokenAmount
        tokenAccountOut = getAssociatedTokenAddressSync(poolKeys.quoteMint, poolCreator)
        tokenAccountIn = getAssociatedTokenAddressSync(poolKeys.baseMint, poolCreator)
        const infos = await connection.getMultipleAccountsInfo([poolCreator, buyer, tokenAccountIn, tokenAccountOut]).catch(async () => {
            await sleep(2_000)
            return await connection.getMultipleAccountsInfo([poolCreator, buyer, tokenAccountIn, tokenAccountOut]).catch((getMultipleAccountsInfoError) => {
                log({ getMultipleAccountsInfoError })
                return null
            })
        })
        if (!infos) return { Err: "Failed to prepare buy transaction" }
        const [poolCreatorAccountInfo, buyerAccountInfo, buyerInAtaInfo, buyerOutAtaInfo] = infos
        if (!poolCreatorAccountInfo) return { Err: "pool creator wallet dosen't have enought Sol to create pool" }
        const creatorBalance = poolCreatorAccountInfo.lamports
        if (creatorBalance < createPoolSolFund) return { Err: "pool creator wallet dosen't have enought Sol to create pool" }
        if (!buyerAccountInfo) return { Err: "buyer wallet dosen't have enought Sol to create pool" }
        const balance = calcDecimalValue(buyerAccountInfo.lamports, 9)
        let minRequiredBuyerBalance = 0
        if (amountIn.token.mint.toBase58() == NATIVE_MINT.toBase58()) {
            minRequiredBuyerBalance += calcDecimalValue(amountIn.raw.toNumber(), 9)
            if (balance < minRequiredBuyerBalance) return { Err: "Buyer wallet dosen't have enought Sol to buy or distribute the tokens" }
        } else {
            if (!buyerInAtaInfo) return { Err: "Buyer wallet dosen't have enought fund to buy another token" }
            const tokenBalance = Number(AccountLayout.decode(buyerInAtaInfo.data).amount.toString())
            if (tokenBalance < amountIn.raw.toNumber()) {
                return { Err: "Buyer dosen't have enought fund to buy another token" }
            }
        }
        if (!buyerInAtaInfo) preBuyIxs.push(createAssociatedTokenAccountInstruction(buyer, tokenAccountIn, buyer, amountIn.token.mint))
        if (!buyerOutAtaInfo) preBuyIxs.push(createAssociatedTokenAccountInstruction(buyer, tokenAccountOut, buyer, amountOut.token.mint))
    }
    const buyFromPoolTxInfo = await baseRay.buyFromPool({
        amountIn, amountOut, fixedSide: 'out', poolKeys, tokenAccountIn, tokenAccountOut, user: buyer, skipAtaInit: true
    }).catch((innerBuyTxError) => { log({ innerBuyTxError }); return null })
    if (!buyFromPoolTxInfo) return { Err: "Failed to create buy transaction" }
    const createPoolRecentBlockhash = (await connection.getLatestBlockhash({ commitment: 'confirmed' }).catch(async () => {
        await sleep(1_000)
        return await connection.getLatestBlockhash({ commitment: 'confirmed' }).catch(getLatestBlockhashError => {
            log({ getLatestBlockhashError })
            return null
        })
    }))?.blockhash;
    if (!createPoolRecentBlockhash) return { Err: "Failed to prepare transaction" }
    const createPoolTxMsg = new web3.TransactionMessage({
        instructions: createPoolTxInfo.ixs,
        payerKey: poolCreator,
        recentBlockhash: createPoolRecentBlockhash
    }).compileToV0Message()
    const createPoolTx = new web3.VersionedTransaction(createPoolTxMsg)
    createPoolTx.sign([poolCreatorAuthority, ...createPoolTxInfo.signers])

    await sleep(500)
    const buyRecentBlockhash = (await connection.getLatestBlockhash({ commitment: 'confirmed' }).catch(async () => {
        await sleep(1_000)
        return await connection.getLatestBlockhash({ commitment: 'confirmed' }).catch(getLatestBlockhashError => {
            log({ getLatestBlockhashError })
            return null
        })
    }))?.blockhash;
    if (!buyRecentBlockhash) return { Err: "Failed to prepare transaction" }
    const buyTxMsg = new web3.TransactionMessage({
        instructions: [...preBuyIxs, ...buyFromPoolTxInfo.ixs],
        payerKey: buyer,
        recentBlockhash: buyRecentBlockhash
    }).compileToV0Message()
    const buyTx = new web3.VersionedTransaction(buyTxMsg)
    buyTx.sign([buyerAuthority])
    log(`Pool Id: ${poolId.toBase58()}`)

    // const createSim = (await connection.simulateTransaction(createPoolTx)).value
    // log({ createSim: JSON.stringify(createSim) })

    // {
    //     const createPoolRes = await connection.sendTransaction(createPoolTx)
    //     log({ createPoolRes })
    //     await sleep(4_000)
    //     const buyTxRes = await connection.sendTransaction(buyTx)
    //     log({ buyTxRes })
    // }
    // return { Err: "test" }

    const bundleTxRes = await sendBundle([createPoolTx, buyTx], poolCreatorAuthority, BUNDLE_FEE, connection).catch(async () => {
        return null
    }).then(async (res) => {
        if (res === null || typeof res.Err == 'string') {
            await sleep(2_000)
            return await sendBundle([createPoolTx, buyTx], poolCreatorAuthority, BUNDLE_FEE, connection).catch((sendBundleError) => {
                log({ sendBundleError })
                return null
            })
        }
        return res
    })
    // let bundleTxRes = null as any
    if (!bundleTxRes) {
        return { Err: "Failed to send the bundle" }
    }
    if (bundleTxRes.Ok) {
        const { bundleId, bundleStatus, txsSignature } = bundleTxRes.Ok
        const createPoolTxSignature = txsSignature[0]
        const buyTxSignature = txsSignature[1]
        if (!createPoolTxSignature || !buyTxSignature) return { Err: { bundleId, poolId: poolId.toBase58() } }
        return {
            Ok: {
                bundleId,
                poolId: poolId.toBase58(),
                createPoolTxSignature,
                buyTxSignature,
                bundleStatus,
            }
        }
    } else if (bundleTxRes.Err) {
        const Err = bundleTxRes.Err
        if (typeof Err == 'string') {
            return { Err }
        } else {
            return {
                Err: {
                    bundleId: Err.bundleId,
                    poolId: poolId.toBase58(),
                }
            }
        }
    }
    return { Err: "Failed to send the bundle" }
}


async function sendBundle(txs: web3.VersionedTransaction[], feePayerAuthority: web3.Keypair, bundleTips: number, connection: web3.Connection, addFeeTx = true): Promise<Result<{
    bundleId: string, txsSignature: string[], bundleStatus: number
}, { bundleId: string } | string>> {
    const jitoClient = searcherClient(ENV.JITO_BLOCK_ENGINE_URL, ENV.JITO_AUTH_KEYPAIR)
    const jitoTipAccounts = await jitoClient.getTipAccounts().catch(getTipAccountsError => { log({ getTipAccountsError }); return null });
    if (!jitoTipAccounts) return { Err: "Unable to prepare the bunde transaction" }
    const jitoTipAccount = new web3.PublicKey(
        jitoTipAccounts[Math.floor(Math.random() * jitoTipAccounts.length)]
    );
    // log("tip Account: ", jitoTipAccount.toBase58())
    const jitoLeaderNextSlot = (await jitoClient.getNextScheduledLeader().catch(getNextScheduledLeaderError => { log({ getNextScheduledLeaderError }); return null }))?.nextLeaderSlot;
    if (!jitoLeaderNextSlot) return { Err: "Unable to prepare the bunde transaction" }
    // log("jito LedgerNext slot", jitoLeaderNextSlot)
    const recentBlockhash = (await (connection.getLatestBlockhash())).blockhash
    let b = new bundle.Bundle(txs, txs.length + 1).addTipTx(
        feePayerAuthority,
        bundleTips,
        jitoTipAccount,
        recentBlockhash
    )
    if (b instanceof Error) {
        log({ bundleError: b })
        return { Err: "Failed to prepare the bunde transaction" }
    }
    const finalRes = { pass: false }
    jitoClient.onBundleResult(
        (bundleInfo) => {
            if (bundleInfo.accepted) {
                finalRes.pass = true
            }
            log({ bundleInfo: JSON.stringify(bundleInfo) })
        },
        (bundleSendError) => {
            log({ bundleSendError: JSON.stringify(bundleSendError) })
        }
    )
    const bundleId = await jitoClient.sendBundle(b).catch(async () => {
        await sleep(1_000)
        return await jitoClient.sendBundle(b as any).catch((sendBunderError) => {
            log({ sendBunderError })
            return null
        })
    })
    if (!bundleId) {
        return { Err: "Bundle transaction failed" }
    }
    log({ bundleId })
    for (let i = 0; i < 100; ++i) {
        if (finalRes.pass) {
            break
        }
        await sleep(1000)
    }

    const bundleRes = await getBunderInfo(bundleId).catch(async () => null).then(async (res) => {
        if (res) return res
        await sleep(10_000)
        return await getBunderInfo(bundleId).catch((getBunderInfoError) => {
            log({ getBunderInfoError })
            return null
        })
    })
    if (bundleRes === undefined) {
        //TODO: Bundle failed
        return { Err: { bundleId } }
    }
    if (!bundleRes) {
        return { Err: { bundleId } }
    }
    const { transactions, status } = bundleRes;
    if (!transactions || !status) {
        return { Err: { bundleId } }
    }
    return {
        Ok: {
            bundleId,
            bundleStatus: status,
            txsSignature: transactions
        }
    }
}

async function getBunderInfo(bundleId: string): Promise<BundleRes> {
    const bundleRes = await fetch("https://explorer.jito.wtf/api/graphqlproxy", {
        "headers": {
            "accept": "*/*",
            "accept-language": "en-GB,en;q=0.5",
            "content-type": "application/json",
            "Referer": `https://explorer.jito.wtf/bundle/${bundleId}`
        },
        "body": `{\"operationName\":\"getBundleById\",\"variables\":{\"id\":\"${bundleId}\"},\"query\":\"query getBundleById($id: String!) {\\n  getBundle(req: {id: $id}) {\\n    bundle {\\n      uuid\\n      timestamp\\n      validatorIdentity\\n      transactions\\n      slot\\n      status\\n      landedTipLamports\\n      signer\\n      __typename\\n    }\\n    __typename\\n  }\\n}\"}`,
        "method": "POST"
    });
    const bundleResJ = await bundleRes.json()
    return bundleResJ?.data?.getBundle?.bundle
}