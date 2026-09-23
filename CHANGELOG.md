# Changelog

## [0.8.0](https://github.com/danielscholl/keelson-rib-chat/compare/v0.7.0...v0.8.0) (2026-09-23)


### Added

* **surface:** copy the conclusion and read gate files in the pane ([#40](https://github.com/danielscholl/keelson-rib-chat/issues/40)) ([272b883](https://github.com/danielscholl/keelson-rib-chat/commit/272b88399c9154ee20753d2b5b6e071997afa5c5))
* **surface:** reply in a gate thread from the swarm drawer ([#37](https://github.com/danielscholl/keelson-rib-chat/issues/37)) ([bd0bb82](https://github.com/danielscholl/keelson-rib-chat/commit/bd0bb829d71a4b530559b595cab29e0fedc0bcbb))
* **surface:** show a swarm's recent activity ([#39](https://github.com/danielscholl/keelson-rib-chat/issues/39)) ([e66a358](https://github.com/danielscholl/keelson-rib-chat/commit/e66a358c7603a5d1f6b7f63735effaa5e4ba16ad))
* **swarm:** count the tokens each agent and swarm spends ([#38](https://github.com/danielscholl/keelson-rib-chat/issues/38)) ([ffb979e](https://github.com/danielscholl/keelson-rib-chat/commit/ffb979e52b16cd916d7dbc843e2b89b7ca083448))
* **swarm:** flag an agent's question to the operator and hold the swarm for it ([#36](https://github.com/danielscholl/keelson-rib-chat/issues/36)) ([1d5f49b](https://github.com/danielscholl/keelson-rib-chat/commit/1d5f49b19954d9f409d5baa3e50e084f3183e692))


### Fixed

* **surface:** show a long question in full and clean up the drawer's text ([#44](https://github.com/danielscholl/keelson-rib-chat/issues/44)) ([40dfd06](https://github.com/danielscholl/keelson-rib-chat/commit/40dfd06aaa793464d1412952dd2ff3cf240866b4))


### Documentation

* **design:** mark the shipped tiers and settled decisions ([#41](https://github.com/danielscholl/keelson-rib-chat/issues/41)) ([2f8a440](https://github.com/danielscholl/keelson-rib-chat/commit/2f8a440be80d898c94a7051aa401b8ffa27d0260))

## [0.7.0](https://github.com/danielscholl/keelson-rib-chat/compare/v0.6.0...v0.7.0) (2026-09-22)


### Added

* **surface:** add a ClickClack footer to the Swarms tab ([#34](https://github.com/danielscholl/keelson-rib-chat/issues/34)) ([5aab8fd](https://github.com/danielscholl/keelson-rib-chat/commit/5aab8fd4e5e79610e0cf1c7709db464c2778386b))
* **surface:** add the Swarms tab with index, drawer and reading pane ([#29](https://github.com/danielscholl/keelson-rib-chat/issues/29)) ([3127d47](https://github.com/danielscholl/keelson-rib-chat/commit/3127d47ab9254d240fdb6e72ccbefb819fef4cac))
* **surface:** start swarms from the tab and run ended ones again ([#32](https://github.com/danielscholl/keelson-rib-chat/issues/32)) ([4c12ddc](https://github.com/danielscholl/keelson-rib-chat/commit/4c12ddc859e69fe5fa622e7ca51bebe9a433112e))
* **swarm:** add size presets and record the model each swarm runs ([#26](https://github.com/danielscholl/keelson-rib-chat/issues/26)) ([7540c1a](https://github.com/danielscholl/keelson-rib-chat/commit/7540c1a9fe2b66b603532ab98f88d038fed5ef11))
* **swarm:** let the lead publish a designed report page ([#35](https://github.com/danielscholl/keelson-rib-chat/issues/35)) ([e76886f](https://github.com/danielscholl/keelson-rib-chat/commit/e76886f160eadbf7ea71b657d2f049ec5f25d1ce))
* **swarm:** report changes and keep ended swarms across restarts ([#27](https://github.com/danielscholl/keelson-rib-chat/issues/27)) ([3127d47](https://github.com/danielscholl/keelson-rib-chat/commit/3127d47ab9254d240fdb6e72ccbefb819fef4cac))
* **swarm:** track health, gate answerers and quiet gates ([#28](https://github.com/danielscholl/keelson-rib-chat/issues/28)) ([3127d47](https://github.com/danielscholl/keelson-rib-chat/commit/3127d47ab9254d240fdb6e72ccbefb819fef4cac))


### Fixed

* **surface:** tidy ended swarms on the Swarms tab ([#31](https://github.com/danielscholl/keelson-rib-chat/issues/31)) ([8607e5f](https://github.com/danielscholl/keelson-rib-chat/commit/8607e5faaa6e84f7b58d9ad0834a6317953b2451))


### Documentation

* **design:** add the Swarms surface design ([#25](https://github.com/danielscholl/keelson-rib-chat/issues/25)) ([531a9b4](https://github.com/danielscholl/keelson-rib-chat/commit/531a9b4a8c81e30b2f876065aa8f8bed3fdfd4c1))

## [0.6.0](https://github.com/danielscholl/keelson-rib-chat/compare/v0.5.0...v0.6.0) (2026-09-22)


### Added

* **dispatch:** let the swarm answer a run's approval gates ([#23](https://github.com/danielscholl/keelson-rib-chat/issues/23)) ([d78150d](https://github.com/danielscholl/keelson-rib-chat/commit/d78150d0a4bdef1032ddd77386db2fd51364dd04))

## [0.5.0](https://github.com/danielscholl/keelson-rib-chat/compare/v0.4.0...v0.5.0) (2026-09-22)


### Added

* **dispatch:** require passing CI before a run is verified ([#21](https://github.com/danielscholl/keelson-rib-chat/issues/21)) ([7870e41](https://github.com/danielscholl/keelson-rib-chat/commit/7870e41e01c4c09a3eb7f82022933cd6d1980417))

## [0.4.0](https://github.com/danielscholl/keelson-rib-chat/compare/v0.3.0...v0.4.0) (2026-09-22)


### Added

* **swarm:** let the lead dispatch Keelson workflows ([#19](https://github.com/danielscholl/keelson-rib-chat/issues/19)) ([ed55739](https://github.com/danielscholl/keelson-rib-chat/commit/ed557392fab0b93d4f993219acbc1060e6be8a33))
* **swarm:** survive failed turns and narrow thread wakes ([#18](https://github.com/danielscholl/keelson-rib-chat/issues/18)) ([a510728](https://github.com/danielscholl/keelson-rib-chat/commit/a5107285ef2a19d1627cfe2582215d8c12213f65))

## [0.3.0](https://github.com/danielscholl/keelson-rib-chat/compare/v0.2.0...v0.3.0) (2026-09-21)


### Added

* **clickclack:** fail fast when the server is unreachable ([#16](https://github.com/danielscholl/keelson-rib-chat/issues/16)) ([63366d6](https://github.com/danielscholl/keelson-rib-chat/commit/63366d63e450ef653d8825168608d015de1e8214))


### Fixed

* **workflows:** pin chat-swarm nodes to mai-code-1.1-flash on copilot ([#14](https://github.com/danielscholl/keelson-rib-chat/issues/14)) ([d529150](https://github.com/danielscholl/keelson-rib-chat/commit/d529150d913b64f0c650f6c3c93a671f5d915a2c))

## [0.2.0](https://github.com/danielscholl/keelson-rib-chat/compare/v0.1.0...v0.2.0) (2026-09-21)


### Added

* **chat:** add keelson rib for ClickClack agent swarms ([310c3ab](https://github.com/danielscholl/keelson-rib-chat/commit/310c3abea99aee5d1b4b7b4aebc31637b6d2fcd6))
* **docs:** expose the swarm contract through keelson_docs ([#7](https://github.com/danielscholl/keelson-rib-chat/issues/7)) ([7da4c61](https://github.com/danielscholl/keelson-rib-chat/commit/7da4c6189bf0b1ab8176b99cdf6fd702b02f6811)), closes [#4](https://github.com/danielscholl/keelson-rib-chat/issues/4)
* **swarm:** give read-only workers authoritative task context ([#8](https://github.com/danielscholl/keelson-rib-chat/issues/8)) ([caee7fa](https://github.com/danielscholl/keelson-rib-chat/commit/caee7fa1a3136f8dc51666c371a901f0cfc620cf)), closes [#5](https://github.com/danielscholl/keelson-rib-chat/issues/5)


### Documentation

* add the documentation site ([#10](https://github.com/danielscholl/keelson-rib-chat/issues/10)) ([528c9eb](https://github.com/danielscholl/keelson-rib-chat/commit/528c9ebe96690984284cb1e0f517a7438e96c4b5))
