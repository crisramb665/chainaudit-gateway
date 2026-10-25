// Sends a few ETH transfers between Anvil's default accounts so the MCP tools
// have balances and transactions to read. Goes straight to Anvil (:8545), not
// through Toxiproxy, so leftover toxics cannot break seeding.
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'

// Anvil's public development mnemonic. These keys hold no real value.
const MNEMONIC = 'test test test test test test test test test test test junk'
const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545'

const accounts = [0, 1, 2, 3, 4].map((addressIndex) => mnemonicToAccount(MNEMONIC, { addressIndex }))
const transport = http(rpcUrl, { timeout: 5_000 })
const publicClient = createPublicClient({ chain: foundry, transport })

// [from, to, ether]
const transfers: Array<[number, number, string]> = [
  [0, 1, '1'],
  [0, 2, '2.5'],
  [1, 3, '0.5'],
  [2, 4, '0.1'],
  [3, 0, '0.25'],
]

function account(index: number) {
  const found = accounts[index]
  if (!found) throw new Error(`No Anvil account at index ${index}`)
  return found
}

for (const [from, to, ether] of transfers) {
  const wallet = createWalletClient({ account: account(from), chain: foundry, transport })
  const hash = await wallet.sendTransaction({ to: account(to).address, value: parseEther(ether) })
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 10_000 })
  console.log(`#${from} -> #${to}  ${ether} ETH  block ${receipt.blockNumber}  ${hash}`)
}

console.log('\nBalances:')
for (const [index, { address }] of accounts.entries()) {
  const wei = await publicClient.getBalance({ address })
  console.log(`#${index} ${address}  ${formatEther(wei)} ETH`)
}
