// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ELOLib - ELO-style rating system for agent reputation
/// @notice Adapted from chess ELO for service provider ratings
/// @dev Uses fixed-point math with 1e4 precision to avoid floating point
library ELOLib {
    uint256 constant BASE_RATING = 1000;
    uint256 constant K_FACTOR = 32;           // Standard K-factor
    uint256 constant K_FACTOR_NEW = 64;       // Higher K for new agents (< 30 games)
    uint256 constant NEW_AGENT_THRESHOLD = 30;
    uint256 constant PRECISION = 10000;

    /// @notice Calculate new rating after a service completion (win)
    /// @param rating Current rating
    /// @param opponentRating Rating of the other party
    /// @param completedCount Total completed services (for K-factor selection)
    /// @return New rating
    function ratingAfterWin(
        uint256 rating,
        uint256 opponentRating,
        uint256 completedCount
    ) internal pure returns (uint256) {
        uint256 expected = expectedScore(rating, opponentRating);
        uint256 k = completedCount < NEW_AGENT_THRESHOLD ? K_FACTOR_NEW : K_FACTOR;

        // actual score = 1.0 (win) = PRECISION
        uint256 delta = (k * (PRECISION - expected)) / PRECISION;
        return rating + delta;
    }

    /// @notice Calculate new rating after a service failure (loss)
    /// @param rating Current rating
    /// @param opponentRating Rating of the other party
    /// @param completedCount Total completed services
    /// @return New rating (minimum 100)
    function ratingAfterLoss(
        uint256 rating,
        uint256 opponentRating,
        uint256 completedCount
    ) internal pure returns (uint256) {
        uint256 expected = expectedScore(rating, opponentRating);
        uint256 k = completedCount < NEW_AGENT_THRESHOLD ? K_FACTOR_NEW : K_FACTOR;

        // actual score = 0.0 (loss)
        uint256 delta = (k * expected) / PRECISION;
        if (delta >= rating - 100) return 100; // floor at 100
        return rating - delta;
    }

    /// @notice Expected score based on rating difference
    /// @dev Approximates 1 / (1 + 10^((rB - rA)/400)) using piecewise linear
    /// @return Expected score in PRECISION units (0..PRECISION)
    function expectedScore(uint256 ratingA, uint256 ratingB) internal pure returns (uint256) {
        // Simplified piecewise linear approximation of the logistic curve
        // For a hackathon this is practical; production would use lookup tables
        int256 diff = int256(ratingA) - int256(ratingB);

        if (diff > 400) return 9000;       // ~0.90
        if (diff > 200) return 7500;       // ~0.75
        if (diff > 100) return 6400;       // ~0.64
        if (diff > 50) return 5700;        // ~0.57
        if (diff > -50) return 5000;       // ~0.50
        if (diff > -100) return 4300;      // ~0.43
        if (diff > -200) return 3600;      // ~0.36
        if (diff > -400) return 2500;      // ~0.25
        return 1000;                        // ~0.10
    }

    /// @notice Slash rating by a percentage (basis points)
    /// @param rating Current rating
    /// @param basisPoints Slash amount in basis points (100 = 1%)
    /// @return New rating (minimum 100)
    function slash(uint256 rating, uint256 basisPoints) internal pure returns (uint256) {
        uint256 penalty = (rating * basisPoints) / 10000;
        if (penalty >= rating - 100) return 100;
        return rating - penalty;
    }
}
