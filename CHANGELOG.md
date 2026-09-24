# Changelog

## [0.13.0](https://github.com/danielscholl/keelson-rib-chat/compare/v0.12.0...v0.13.0) (2026-09-24)


### Added

* **surface:** flag providers that serve one model at every power ([#65](https://github.com/danielscholl/keelson-rib-chat/issues/65)) ([e38d532](https://github.com/danielscholl/keelson-rib-chat/commit/e38d532bb6845ee9248d126b68afbf19445f753d))
* **surface:** offer write the project on the launch form ([#77](https://github.com/danielscholl/keelson-rib-chat/issues/77)) ([c8a8381](https://github.com/danielscholl/keelson-rib-chat/commit/c8a8381893f391b621c70297800952c08341809b))
* **swarm:** add chat_pr_open and chat_diff for writers ([#76](https://github.com/danielscholl/keelson-rib-chat/issues/76)) ([d9f36ea](https://github.com/danielscholl/keelson-rib-chat/commit/d9f36eaec7182c7ee13d0e829a8af988f6ad3f2f))
* **swarm:** add write mode with per-writer git worktrees ([#75](https://github.com/danielscholl/keelson-rib-chat/issues/75)) ([2b0a3d0](https://github.com/danielscholl/keelson-rib-chat/commit/2b0a3d0c4b68ee49c1eb35ff0f2053f8e29c627d))
* **swarm:** forget ended swarms, and lend the lead other ribs' tools ([#66](https://github.com/danielscholl/keelson-rib-chat/issues/66)) ([f269aeb](https://github.com/danielscholl/keelson-rib-chat/commit/f269aebc1a2bd39044f5cd8ab029c79aa7538db9))
* **tools:** read the newest messages of a swarm transcript ([#70](https://github.com/danielscholl/keelson-rib-chat/issues/70)) ([f8b80ad](https://github.com/danielscholl/keelson-rib-chat/commit/f8b80ad222bb0da9ee4f991312b95c1138a271c4))


### Fixed

* **dispatch:** never credit a run with another run's pull request ([#67](https://github.com/danielscholl/keelson-rib-chat/issues/67)) ([2da689a](https://github.com/danielscholl/keelson-rib-chat/commit/2da689a631373e5a1f79af7a538f549555c636c0))
* **dispatch:** serialize run starts per project and keep the lead waiting ([#68](https://github.com/danielscholl/keelson-rib-chat/issues/68)) ([05fca94](https://github.com/danielscholl/keelson-rib-chat/commit/05fca948386fe9b2fff4b940aa16174e8db584f6))
* **swarm:** leave a gate unanswered when the swarm cancels its run ([#69](https://github.com/danielscholl/keelson-rib-chat/issues/69)) ([a8b8e12](https://github.com/danielscholl/keelson-rib-chat/commit/a8b8e12afd674f09674734cf5f6082dba0b4d67c))
* **swarm:** stop the rib's run and gate posts from waking agents ([#72](https://github.com/danielscholl/keelson-rib-chat/issues/72)) ([42a5063](https://github.com/danielscholl/keelson-rib-chat/commit/42a50639c67c4457c804c25a1ae9d934325156ee))

## [0.12.0](https://github.com/danielscholl/keelson-rib-chat/compare/v0.11.0...v0.12.0) (2026-09-23)


### Added

* **surface:** draw each swarm's record ([#62](https://github.com/danielscholl/keelson-rib-chat/issues/62)) ([65e9ab9](https://github.com/danielscholl/keelson-rib-chat/commit/65e9ab98f70feece0ab8f513c21189fba22c3656))
* **surface:** fold the launcher to its defaults ([#60](https://github.com/danielscholl/keelson-rib-chat/issues/60)) ([31cef0e](https://github.com/danielscholl/keelson-rib-chat/commit/31cef0e5d01666d8b6be7fac6956f89043447843))
* **surface:** lead ended swarms with their outcome ([#59](https://github.com/danielscholl/keelson-rib-chat/issues/59)) ([a348c1e](https://github.com/danielscholl/keelson-rib-chat/commit/a348c1e3fc8aa6b22db23147fae494c52979b775))
* **swarm:** record each turn, its cause and its actor ([#61](https://github.com/danielscholl/keelson-rib-chat/issues/61)) ([00c2642](https://github.com/danielscholl/keelson-rib-chat/commit/00c264288b797863c8cd0a1bca4c92014ba1c655))


### Documentation

* **design:** add the third Swarms tab iteration ([#58](https://github.com/danielscholl/keelson-rib-chat/issues/58)) ([f78723b](https://github.com/danielscholl/keelson-rib-chat/commit/f78723b26ef02a2c1727af09a5030fe0c33d3a20))

## [0.11.0](https://github.com/danielscholl/keelson-rib-chat/compare/v0.10.0...v0.11.0) (2026-09-23)


### Added

* **surface:** adopt the 0.112 canvas: clocks, captioned meters, edges and toasts ([#55](https://github.com/danielscholl/keelson-rib-chat/issues/55)) ([5b25b2e](https://github.com/danielscholl/keelson-rib-chat/commit/5b25b2e1a78301a0fe1925edece23dee0c9c5010))


### Fixed

* **swarm:** count only messages addressed to the operator as questions ([#56](https://github.com/danielscholl/keelson-rib-chat/issues/56)) ([746902d](https://github.com/danielscholl/keelson-rib-chat/commit/746902dd1c668d739b19b197e5649956bec1d847))
* **swarm:** tell the lead when only the operator can answer a gate ([#54](https://github.com/danielscholl/keelson-rib-chat/issues/54)) ([313df37](https://github.com/danielscholl/keelson-rib-chat/commit/313df371f108b64d63dc52fb753638a820feb399))

## [0.10.0](https://github.com/danielscholl/keelson-rib-chat/compare/v0.9.0...v0.10.0) (2026-09-23)


### Added

* **surface:** rebuild the Swarms tab around the decision ([#50](https://github.com/danielscholl/keelson-rib-chat/issues/50)) ([6619cea](https://github.com/danielscholl/keelson-rib-chat/commit/6619ceaf7da5e389987b3721a935aafec1dd4029))
* **surface:** start ClickClack from a request and keep the full log ([#51](https://github.com/danielscholl/keelson-rib-chat/issues/51)) ([2173c43](https://github.com/danielscholl/keelson-rib-chat/commit/2173c43c38b29c988723907856bb7b9805e67e22))

## [0.9.0](https://github.com/danielscholl/keelson-rib-chat/compare/v0.8.0...v0.9.0) (2026-09-23)


### Added

* **surface:** open a run from the drawer and badge the Swarms tab ([#47](https://github.com/danielscholl/keelson-rib-chat/issues/47)) ([9cc0419](https://github.com/danielscholl/keelson-rib-chat/commit/9cc0419ef62938cfc1263fedeee373d737a0b731))
* **swarm:** name the model that served each agent ([#46](https://github.com/danielscholl/keelson-rib-chat/issues/46)) ([21da7a1](https://github.com/danielscholl/keelson-rib-chat/commit/21da7a15cf0ee32de75e5f3d44302f2bc3099bfe))
* **swarm:** pick a swarm's power, fast, balanced or deep ([#45](https://github.com/danielscholl/keelson-rib-chat/issues/45)) ([b1f9e04](https://github.com/danielscholl/keelson-rib-chat/commit/b1f9e04bfb487c233ada1e5af0afcc2619a26ff6))

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
