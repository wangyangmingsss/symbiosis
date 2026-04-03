// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title DutchAuctionLib - Decaying price auction math
/// @notice Price decays linearly from startPrice to floorPrice over blocks
library DutchAuctionLib {
    /// @notice Calculate current Dutch auction price
    /// @param startPrice Initial asking price (6 decimal USDT)
    /// @param floorPrice Minimum price (6 decimal USDT)
    /// @param decayRate Price decrease per block (6 decimal USDT)
    /// @param listedAtBlock Block when listing was created
    /// @param currentBlock Current block number
    /// @return Current price in USDT (6 decimals)
    function currentPrice(
        uint256 startPrice,
        uint256 floorPrice,
        uint256 decayRate,
        uint256 listedAtBlock,
        uint256 currentBlock
    ) internal pure returns (uint256) {
        if (currentBlock <= listedAtBlock) return startPrice;

        uint256 elapsed = currentBlock - listedAtBlock;
        uint256 decay = elapsed * decayRate;

        if (decay >= startPrice - floorPrice) {
            return floorPrice;
        }

        return startPrice - decay;
    }

    /// @notice Estimate blocks until price reaches a target
    function blocksUntilPrice(
        uint256 startPrice,
        uint256 targetPrice,
        uint256 floorPrice,
        uint256 decayRate
    ) internal pure returns (uint256) {
        if (targetPrice <= floorPrice) {
            if (decayRate == 0) return type(uint256).max;
            return (startPrice - floorPrice + decayRate - 1) / decayRate;
        }
        if (targetPrice >= startPrice) return 0;
        return (startPrice - targetPrice + decayRate - 1) / decayRate;
    }
}
