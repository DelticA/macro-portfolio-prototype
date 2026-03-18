from __future__ import annotations

from ..models.policy.cvar import CvarPolicyModel
from ..models.policy.risk_parity import RiskParityPolicyModel
from ..models.policy.template import TemplateRulePolicyModel
from ..models.regime.gmm import GMMRegimeModel
from ..models.regime.kmeans import KMeansRegimeModel
from ..models.regime.rule_based import RuleBasedRegimeModel
from ..policy import PolicyConfig
from ..types import AssetConfig


def build_regime_model(name: str, **params):
    registry = {
        "rule_based": lambda: RuleBasedRegimeModel(smoothing_window=params.get("smoothing_window", 3)),
        "kmeans": lambda: KMeansRegimeModel(n_states=params.get("n_states", 4)),
        "gmm": lambda: GMMRegimeModel(n_states=params.get("n_states", 4)),
    }
    if name not in registry:
        raise ValueError(f"Unsupported regime model: {name}")
    return registry[name]()


def build_policy_model(name: str, assets: list[AssetConfig], config: PolicyConfig):
    registry = {
        "template_rule": lambda: TemplateRulePolicyModel(assets=assets, config=config),
        "risk_parity": lambda: RiskParityPolicyModel(assets=assets, config=config),
        "cvar": lambda: CvarPolicyModel(assets=assets, config=config),
    }
    if name not in registry:
        raise ValueError(f"Unsupported policy model: {name}")
    return registry[name]()
