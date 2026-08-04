-- 04.08.2026 - сброс PIN на четырёх постоянных логинах, у которых актуальный PIN
-- нигде в репозитории не был документирован (проверено живым POST /auth/login
-- на проде - старые значения из tools/*.mjs не подошли ни для одного из этих
-- четырёх аккаунтов). master1-test@alikhan.test (Алиовсад) не трогаем - его PIN
-- 1111 подтверждён живым логином, менять не нужно.
--
-- Влад явно попросил сбросить всем новой миграцией (не подбирать вслепую).
-- PIN-хэши сгенерированы hashPin() из api/server.mjs.
UPDATE staff SET pin_hash = '7d04f2e1c0a6b277fd34ea25ef080c6e:5d83aedbe7e9346613eee6dc7ba25701f7801580133b763b84c45d05b13cd6bbb10eaea54edd14a591287405ae0223f77042ec6939f37ee849d97e57a6f4a66a' WHERE email = 'master2-test@alikhan.test';
UPDATE staff SET pin_hash = 'f48b0d11cc05ff883c41c8d89d632c76:a41b743a883ea1881953231fb713c2c3f5704f4a7c397551a31311f7a384d8527c3f189cb53c3ff32834afa5725dbc84babb6424485df5a12afd4dcc1968dfc9' WHERE email = 'master3-test@alikhan.test';
UPDATE staff SET pin_hash = 'ec736b27fe2db3d1dbd50351c666356f:a05bd0f0c9c08730ee0e700067bf53f9cb1a88dfa23f0b595c6b42672a5d4412ed0dfd53b96a85af70bc227e6c8fdaf9d131160f82983b5c772da8a3c0a964bb' WHERE email = 'admin1-test@alikhan.test';
UPDATE staff SET pin_hash = 'd34be2733a60f0ec0d52aa99559d3d05:e4ddaa0022d2e6cc8723033482b9af0af41a5dc0a2332a37a63f392e34183c0834f4b606853b918318fe2f2bcbd03b7c95a7dc8ef699139e553b07f031fe7bc6' WHERE email = 'admin2-test@alikhan.test';
