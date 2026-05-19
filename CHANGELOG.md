# Changelog

## 1.0.0 (2026-05-19)


### Features

* initial commit ([0d308df](https://github.com/mshick/dyno/commit/0d308dfdbf54908d640d5788f0175d9979c01a98))


### Bug Fixes

* calculateDelay off-by-one + missing max cap ([#3](https://github.com/mshick/dyno/issues/3)) ([f5753ee](https://github.com/mshick/dyno/commit/f5753eeceee3abd0e314b8c21cb4926237e352d8))
* catch rejected send() in sendAll/sendCompletely workers ([058d23d](https://github.com/mshick/dyno/commit/058d23d1254758cd7bac229bc078da90d3c4edf0))
* catch rejected send() in sendAll/sendCompletely workers ([3ab0455](https://github.com/mshick/dyno/commit/3ab04550ad2bc85e8dab6b7de633cc3ecea7dde4)), closes [#6](https://github.com/mshick/dyno/issues/6)
* compare TableStatus to TableStatus.CREATING in waitForTable ([daab807](https://github.com/mshick/dyno/commit/daab8075cc36997e8f57ec5b3b0187c9d4c1c175))
* compare TableStatus to TableStatus.CREATING in waitForTable ([70da571](https://github.com/mshick/dyno/commit/70da571785f19258cb8ac6548f25e953350e6baf)), closes [#2](https://github.com/mshick/dyno/issues/2)
* correct calculateDelay off-by-one and add max cap ([35ca124](https://github.com/mshick/dyno/commit/35ca124d12ab9d4313013930756775c56574903e))
* honor VITEST_NO_DOCKER in vitest global setup ([bff2296](https://github.com/mshick/dyno/commit/bff22968b7b102fe5aaf8a1469c760de8fe26c95)), closes [#4](https://github.com/mshick/dyno/issues/4)
* pass getLimit arguments in declared order ([624acd8](https://github.com/mshick/dyno/commit/624acd8cc5789bdc190a1fe7474b39e6b027c922))
* pass getLimit arguments in declared order ([4296ee2](https://github.com/mshick/dyno/commit/4296ee2b0fe426b55f1e2b35106771d261773956))
* resolve all lint warnings ([0974c2f](https://github.com/mshick/dyno/commit/0974c2f2792001cda77d9d8f5d9af2590a5e93a4))
* restore @smithy/types pnpm override to 4.9.0 ([402a576](https://github.com/mshick/dyno/commit/402a576eab4a910fe927c968104dc2a82ed9302f))
* restore @smithy/types pnpm override to 4.9.0 ([87d53a4](https://github.com/mshick/dyno/commit/87d53a40b3c1fd5d2ebfbbbdb30e3ef47b0054ce)), closes [#5](https://github.com/mshick/dyno/issues/5)
* throw on oversized item in _batchWriteItemRequests ([1caa1d0](https://github.com/mshick/dyno/commit/1caa1d0a8c5628d2ceb2eccf7dbb2df105af23fc))
* throw on oversized item in _batchWriteItemRequests ([62a1759](https://github.com/mshick/dyno/commit/62a1759a18650224c0154de87d348cd8928fb398)), closes [#1](https://github.com/mshick/dyno/issues/1)
