import {Transaction as Transaction_} from "./generated/Transaction_pb";
import {TransactionBody} from "./generated/TransactionBody_pb";
import {Client, TransactionId} from "./Client";
import {SignatureMap, SignaturePair, TransactionID} from "./generated/BasicTypes_pb";
import * as nacl from "tweetnacl";
import {grpc} from "@improbable-eng/grpc-web";
import {TransactionResponse} from "./generated/TransactionResponse_pb";
import {TransactionReceipt} from "./generated/TransactionReceipt_pb";
import {CryptoService} from "./generated/CryptoService_pb_service";
import {
    getMyTxnId,
    handlePrecheck,
    handleQueryPrecheck,
    orThrow, reqDefined,
    reversePrecheck,
    setTimeoutAwaitable,
    timestampToMs
} from "./util";
import {ResponseCodeEnum} from "./generated/ResponseCode_pb";
import {TransactionGetReceiptQuery} from "./generated/TransactionGetReceipt_pb";
import {Query} from "./generated/Query_pb";
import {Message} from "google-protobuf";
import UnaryMethodDefinition = grpc.UnaryMethodDefinition;

/**
 * Signature/public key pairs are passed around as objects
 */
export type SignatureAndKey = {
    signature: Uint8Array,
    publicKey: Uint8Array,
};

const receiptInitialDelayMs = 1000;
const receiptRetryDelayMs = 500;

export default class Transaction {
    private client: Client;

    private inner: Transaction_;
    private txnId: TransactionID;
    private validDurationSeconds: number;
    private method: UnaryMethodDefinition<Transaction_, TransactionResponse>;

    constructor(client: Client, inner: Transaction_, body: TransactionBody, method: UnaryMethodDefinition<Transaction_, TransactionResponse>) {
        this.client = client;
        this.inner = inner;
        this.txnId = orThrow(body.getTransactionid());
        this.validDurationSeconds = orThrow(body.getTransactionvalidduration()).getSeconds();
        this.method = method;
    }

    /**
     * Given the transaction body bytes, asynchronously return a signature and associated public
     * key.
     *
     * @param signer
     */
    async signWith(signer: (bodyBytes: Uint8Array) => Promise<SignatureAndKey>): Promise<this> {
        return this.addSignature(await signer(this.inner.getBodybytes_asU8()));
    }

    getTransactionId(): TransactionId {
        return getMyTxnId(this.txnId);
    }

    addSignature({ signature, publicKey }: SignatureAndKey): this {
        const sigPair = new SignaturePair();
        sigPair.setPubkeyprefix(publicKey);
        sigPair.setEd25519(signature);

        const sigMap = this.inner.getSigmap() || new SignatureMap();
        sigMap.addSigpair(sigPair);
        this.inner.setSigmap(sigMap);

        return this;
    }

    sign(privateKey: Uint8Array): this {
        const signature = nacl.sign(this.inner.getBodybytes_asU8(), privateKey);
        const { publicKey } = nacl.sign.keyPair.fromSecretKey(privateKey);
        return this.addSignature({ signature, publicKey });
    }

    execute(): Promise<TransactionId> {
        const sigMap = this.inner.getSigmap();

        if (!sigMap || sigMap.getSigpairList().length === 0) {
            this.sign(this.client.operatorPrivateKey);
        }

        return this.client.unaryCall(this.inner, this.method)
            .then(handlePrecheck)
            .then(() => getMyTxnId(this.txnId));
    }

    async executeForReceipt(): Promise<TransactionReceipt> {
        await this.execute();
        return this.waitForReceipt()
    }

    private async getReceipt(): Promise<TransactionReceipt> {
        const receiptQuery = new TransactionGetReceiptQuery();
        receiptQuery.setTransactionid(this.txnId);
        const query = new Query();
        query.setTransactiongetreceipt(receiptQuery);

        return this.client.unaryCall(query, CryptoService.getTransactionReceipts)
            .then(handleQueryPrecheck((resp) => resp.getTransactiongetreceipt()))
            .then((receipt) => orThrow(receipt.getReceipt()));
    }

    private async waitForReceipt(): Promise<TransactionReceipt> {
        const validStartMs = timestampToMs(orThrow(this.txnId.getTransactionvalidstart()));
        const validUntilMs = validStartMs + this.validDurationSeconds * 1000;

        await setTimeoutAwaitable(receiptInitialDelayMs);

        let attempt = 0;

        while (true) {
            const receipt = await this.getReceipt();

            // typecast required or we get a mismatching union type error
            if (([ResponseCodeEnum.UNKNOWN, ResponseCodeEnum.OK] as number[])
                .indexOf(receipt.getStatus()) > 0) {
                const delay = Math.floor(receiptRetryDelayMs
                    * Math.random() * (Math.pow(2, attempt) - 1));

                if (validStartMs + delay > validUntilMs) {
                    throw "timed out waiting for consensus on transaction ID: "
                        + this.txnId.toObject();
                }
            } else if (receipt.getStatus() !== ResponseCodeEnum.SUCCESS) {
                throw new Error(reversePrecheck(receipt.getStatus()));
            } else {
                return receipt;
            }
        }
    }

    toProto(): Transaction_ {
        return Message.cloneMessage(this.inner);
    }
}