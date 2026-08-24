# Royal Poker V6.1 — estabilidad

Correcciones principales sobre V6:

- Side pots enviados al cliente como datos planos (`amount` + `eligibleIds`), sin objetos internos, tokens ni timers.
- Estado visual ALL-IN separado de OUT: un jugador con stack 0 durante una mano sigue figurando ALL-IN hasta que termina la mano.
- Desconectar a un jugador que no tiene el turno ya no mueve el turno ni reinicia el reloj del actor actual.
- Una acción inválida ya no regala un reloj nuevo; conserva el timer original.
- Timeout hace CHECK automático cuando no hay apuesta pendiente y FOLD cuando sí la hay.
- La ventana de reconexión se respeta antes de declarar un campeón/cerrar la sala.
- Tokens de reconexión pasan a `sessionStorage` (una identidad por pestaña) y el servidor rechaza un token ya conectado en la misma sala.
- Restart preserva correctamente espectadores y no convierte jugadores desconectados en activos fantasma.
- Cierres diferidos de sala se centralizan/cancelan para evitar timers viejos cerrando una sala recuperada.
- Revive no arranca una mano detrás del showdown; usa el mismo delay de transición.
- Dar fichas a un eliminado en espera puede reanudar correctamente la siguiente mano cuando vuelve a haber 2 jugadores.
- Presets de raise respetan `minRaise` y el formato de incremento que espera el servidor.
- Botón All-In se oculta cuando implicaría una resubida no permitida.
- Música: no vuelve a reprogramar el crossfade en cada interacción.
- Avatares de mesa reducidos nuevamente (62% del contenedor) para dar más aire visual.

Pruebas incluidas:
- `test_v6.js`
- `test_v6_async.js`
- `fuzz_v6.js`
- `test_v61.js` (regresiones de serialización, ALL-IN, timers y desconexión no-current)
