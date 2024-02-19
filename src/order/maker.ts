import { addressToScript, blake160, getTransactionSize, serializeScript, serializeWitnessArgs } from '@nervosnetwork/ckb-sdk-utils'
import { blockchain } from '@ckb-lumos/base'
import {
  getDexLockScript,
  getCotaTypeScript,
  getXudtDep,
  getJoyIDCellDep,
  MAX_FEE,
  JOYID_ESTIMATED_WITNESS_LOCK_SIZE,
  CKB_UNIT,
  getSudtDep,
} from '../constants'
import { Hex, SubkeyUnlockReq, MakerParams, MakerResult, CKBAsset } from '../types'
import { append0x, u128ToLe } from '../utils'
import { UdtException, NoCotaCellException, NoLiveCellException } from '../exceptions'
import { calculateEmptyCellMinCapacity, calculateTransactionFee, calculateUdtCellCapacity } from './helper'
import { CKBTransaction } from '@joyid/ckb'
import { OrderArgs } from './orderArgs'

export const buildMakerTx = async ({
  collector,
  joyID,
  seller,
  listAmount = BigInt(0),
  totalValue,
  assetType,
  fee,
  ckbAsset = CKBAsset.XUDT,
}: MakerParams): Promise<MakerResult> => {
  let txFee = fee ?? MAX_FEE
  const isMainnet = seller.startsWith('ckb')
  const sellerLock = addressToScript(seller)
  const assetTypeScript = blockchain.Script.unpack(assetType) as CKBComponents.Script

  const emptyCells = await collector.getCells({
    lock: sellerLock,
  })
  if (!emptyCells || emptyCells.length === 0) {
    throw new NoLiveCellException('The address has no empty cells')
  }
  const orderArgs = new OrderArgs(sellerLock, 0, totalValue)
  const orderLock: CKBComponents.Script = {
    ...getDexLockScript(isMainnet),
    args: orderArgs.toHex(),
  }
  const orderCellCapacity = calculateUdtCellCapacity(orderLock, assetTypeScript)

  const minCellCapacity = calculateEmptyCellMinCapacity(sellerLock)
  const needCKB = ((orderCellCapacity + minCellCapacity + CKB_UNIT) / CKB_UNIT).toString()
  const errMsg = `At least ${needCKB} free CKB (refundable) is required to place a sell order.`
  const { inputs: emptyInputs, capacity: emptyInputsCapacity } = collector.collectInputs(
    emptyCells,
    orderCellCapacity,
    txFee,
    minCellCapacity,
    errMsg,
  )

  let inputs: CKBComponents.CellInput[] = []
  const outputs: CKBComponents.CellOutput[] = []
  const outputsData: Hex[] = []
  let cellDeps: CKBComponents.CellDep[] = []
  let changeCapacity = BigInt(0)

  if (ckbAsset === CKBAsset.XUDT || ckbAsset === CKBAsset.SUDT) {
    const udtCells = await collector.getCells({
      lock: sellerLock,
      type: assetTypeScript,
    })
    if (!udtCells || udtCells.length === 0) {
      throw new UdtException('The address has no UDT cells')
    }
    const { inputs: udtInputs, capacity: udtInputsCapacity, amount: inputsAmount } = collector.collectUdtInputs(udtCells, listAmount)
    inputs = [...emptyInputs, ...udtInputs]

    outputs.push({
      lock: orderLock,
      type: assetTypeScript,
      capacity: append0x(orderCellCapacity.toString(16)),
    })
    outputsData.push(append0x(u128ToLe(listAmount)))

    changeCapacity = emptyInputsCapacity + udtInputsCapacity - orderCellCapacity - txFee
    if (inputsAmount > listAmount) {
      const udtCellCapacity = calculateUdtCellCapacity(sellerLock, assetTypeScript)
      changeCapacity -= udtCellCapacity
      outputs.push({
        lock: sellerLock,
        type: assetTypeScript,
        capacity: append0x(udtCellCapacity.toString(16)),
      })
      outputsData.push(append0x(u128ToLe(inputsAmount - listAmount)))
    }
    outputs.push({
      lock: sellerLock,
      capacity: append0x(changeCapacity.toString(16)),
    })
    outputsData.push('0x')

    cellDeps.push(ckbAsset === CKBAsset.XUDT ? getXudtDep(isMainnet) : getSudtDep(isMainnet))
  }

  if (joyID) {
    cellDeps.push(getJoyIDCellDep(isMainnet))
  }

  const emptyWitness = { lock: '', inputType: '', outputType: '' }
  let witnesses = [serializeWitnessArgs(emptyWitness)]
  if (joyID && joyID.connectData.keyType === 'sub_key') {
    const pubkeyHash = append0x(blake160(append0x(joyID.connectData.pubkey), 'hex'))
    const req: SubkeyUnlockReq = {
      lockScript: serializeScript(sellerLock),
      pubkeyHash,
      algIndex: 1, // secp256r1
    }
    const { unlockEntry } = await joyID.aggregator.generateSubkeyUnlockSmt(req)
    const emptyWitness = {
      lock: '',
      inputType: '',
      outputType: append0x(unlockEntry),
    }
    witnesses[0] = serializeWitnessArgs(emptyWitness)

    const cotaType = getCotaTypeScript(isMainnet)
    const cotaCells = await collector.getCells({ lock: sellerLock, type: cotaType })
    if (!cotaCells || cotaCells.length === 0) {
      throw new NoCotaCellException("Cota cell doesn't exist")
    }
    const cotaCell = cotaCells[0]
    const cotaCellDep: CKBComponents.CellDep = {
      outPoint: cotaCell.outPoint,
      depType: 'code',
    }
    cellDeps = [cotaCellDep, ...cellDeps]
  }
  const tx: CKBComponents.RawTransaction = {
    version: '0x0',
    cellDeps,
    headerDeps: [],
    inputs,
    outputs,
    outputsData,
    witnesses,
  }

  if (txFee === MAX_FEE) {
    const txSize = getTransactionSize(tx) + (joyID ? JOYID_ESTIMATED_WITNESS_LOCK_SIZE : 0)
    const estimatedTxFee = calculateTransactionFee(txSize)
    txFee = estimatedTxFee
    const estimatedChangeCapacity = changeCapacity + (MAX_FEE - estimatedTxFee)
    tx.outputs[tx.outputs.length - 1].capacity = append0x(estimatedChangeCapacity.toString(16))
  }

  return { rawTx: tx as CKBTransaction, txFee, listPackage: orderCellCapacity, witnessIndex: 0 }
}
