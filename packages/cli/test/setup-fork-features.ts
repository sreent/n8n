// Fork test setup (not in upstream n8n): the upstream tests run with the fork features off, as
// step 5 of FORK.md tells. A fork test that needs them on sets `ForkFeaturesConfig.enabled`.
process.env.N8N_FORK_FEATURES_ENABLED = 'false';
