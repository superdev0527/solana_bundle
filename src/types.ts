import { web3 } from "@project-serum/anchor"
import { Percent } from "@raydium-io/raydium-sdk"
export type CreateTokenInput = {
    name: string,
    symbol?: string,
    image?: string
    website?: string
    decimals: number
    url: 'mainnet' | 'devnet'
    initialMintingAmount: number
}

export type CreateMarketInput = {
    baseMint: web3.PublicKey,
    quoteMint: web3.PublicKey,
    orderSize: number,
    priceTick: number,
    url: 'mainnet' | 'devnet',
}
export type AddLiquidityInput = {
    slippage: Percent,
    poolId: web3.PublicKey,
    amount: number,
    amountSide: 'base' | 'quote',
    url: 'mainnet' | 'devnet',
}
export type RemoveLiquidityInput = {
    poolId: web3.PublicKey,
    amount: number,
    url: 'mainnet' | 'devnet',
    quick?: boolean
}

export type CreatePoolInput = {
    marketId: web3.PublicKey,
    baseMintAmount: number,
    quoteMintAmount: number,
    url: 'mainnet' | 'devnet',
}

export type SwapInput = {
    poolId: web3.PublicKey
    buyToken: "base" | 'quote',
    amountSide: "send" | 'receive',
    amount: number,
    slippage: Percent,
    url: 'mainnet' | 'devnet',
}

export type CreateAndBuy = {
    //pool
    marketId: web3.PublicKey,
    baseMintAmount: number,
    quoteMintAmount: number,
    url: 'mainnet' | 'devnet',

    //buy
    buyToken: 'base' | 'quote',
    buyAmount: number
}

export type BundleRes = {
    uuid: string;
    timestamp: string;
    validatorIdentity: string;
    transactions: string[];
    slot: number;
    status: number;
    landedTipLamports: number;
    signer: string;
    __typename: string;
}
export type BuySellBunldeInput = {
    url: 'mainnet' | 'devnet',
    amount: number,
    amountTokenType: 'base' | 'quote',
    poolId: web3.PublicKey,
    slippage: Percent,
    firstBuyTokenType: 'base' | 'quote'
}