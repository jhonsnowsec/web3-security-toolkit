import { toBN, toStringExp } from "../../../../lib/utils/helpers";
import { ConversionMockContract, ConversionMockInstance } from "../../../../typechain-truffle";
import { getTestFile } from "../../../../lib/test-utils/test-suite-helpers";

const Conversion = artifacts.require("ConversionMock");

contract(`Conversion.sol; ${getTestFile(__filename)};  Conversion unit tests`, accounts => {
    let conversion: ConversionMockInstance;
    const amgToNATWeiPrice = 2;

    before(async() => {
        conversion = await Conversion.new();
    });

    it("should convert correctly", async () => {
        const amgValue = toStringExp(1, 9);
        const res = await conversion.convertAmgToTokenWei(amgValue, amgToNATWeiPrice);
        const expected = 2;
        expect(res).to.eql(toBN(expected));
    });

    it("should convert correctly - 2", async () => {
        const natWeiValue = toStringExp(1, 18);
        const res = await conversion.convertTokenWeiToAMG(natWeiValue, amgToNATWeiPrice);
        const expected = toStringExp(5, 26);
        expect(res).to.eql(toBN(expected));
    });

    it("should calculate correct AMG to Wei price", async () => {
        const AMG_TOKENWEI_PRICE_SCALE = 1e9;
        await conversion.setAssetDecimals(18, 9);
        const price1 = await conversion.calcAmgToTokenWeiPrice(18, 1e5, 5, 1621e5, 5);
        assert.equal(Number(price1), 1621e9 * AMG_TOKENWEI_PRICE_SCALE);
        const wei1 = await conversion.convertAmgToTokenWei(1, price1);
        assert.equal(Number(wei1), 1621e9);
        const wei1_5 = await conversion.convertAmgToTokenWei(5, price1);
        assert.equal(Number(wei1_5), 5 * 1621e9);
    });
});
