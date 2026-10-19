use crate::physical::node::{GrantClientPlan, GrantSyncPlan, NodePlan};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantSyncBatch {
    pub node_id: String,
    pub inbounds: Vec<GrantInboundUpdate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantInboundUpdate {
    pub inbound_tag: String,
    pub clients: Vec<GrantClient>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantClient {
    pub uuid: String,
    pub label: String,
    pub flow: Option<String>,
    pub level: u8,
}

pub fn build(plan: &NodePlan) -> GrantSyncBatch {
    build_sync(&plan.grant_sync)
}

/// Render a grants-only projection without requiring a complete node plan.
pub fn build_sync(plan: &GrantSyncPlan) -> GrantSyncBatch {
    GrantSyncBatch {
        node_id: plan.node_id.clone(),
        inbounds: plan
            .updates
            .iter()
            .map(|update| GrantInboundUpdate {
                inbound_tag: update.inbound_tag.clone(),
                clients: update.clients.iter().map(client).collect(),
            })
            .collect(),
    }
}

fn client(client: &GrantClientPlan) -> GrantClient {
    GrantClient {
        uuid: client.uuid.clone(),
        label: client.label.clone(),
        flow: client.flow.clone(),
        level: 0,
    }
}
