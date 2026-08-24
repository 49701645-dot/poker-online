# Royal Poker V6

## Motor de poker
- Nueva lógica de rondas de apuestas por jugador (`actedThisRound` / `lastActionBet`) en lugar de depender de `actionCount`.
- Big Blind conserva correctamente su opción de check/raise preflop.
- Full raises y short all-ins diferenciados; los short all-ins no reabren acción ilegalmente y pueden reabrirla por acumulación.
- All-ins y jugadores sin posibilidad de apostar se saltean correctamente; Texas corre el board automáticamente cuando corresponde.
- Dealer rota una sola vez por mano; heads-up usa Dealer=SB y el rival=BB.
- Side pots recalculados por niveles de contribución e incluyen fichas de jugadores que foldearon/abandonaron.
- Odd chips se reparten por posición respecto del botón.
- Fold/muck ya no revela cartas ajenas; ganar sin mostrar realmente oculta las cartas.
- Pot se pone en 0 tras pagar el showdown para evitar duplicación visual de fichas.
- Showdown dura lo suficiente antes de comenzar la siguiente mano.
- Pausa cancela/reinicia correctamente los timers.
- Acciones inválidas devuelven error sin dejar la mano congelada.
- No se pueden agregar fichas durante una mano activa.

## Poker Clasico (Five-Card Draw)
- Fases propias: 1ª apuesta -> cambio -> 2ª apuesta -> showdown.
- Pila de descartes y remezcla automática cuando se agota el mazo.
- El jugador no puede volver a robar inmediatamente una carta que acaba de descartar.
- Índices de cambio duplicados se eliminan.
- `maxCardsChange = 0` funciona correctamente.
- Jugadores all-in pueden cambiar cartas y se omite la segunda ronda si nadie puede apostar.
- Jugadores desconectados hacen stand pat automáticamente durante el cambio.

## Online / estados
- Durante una mano no se reordena el array de asientos al desconectarse/irse alguien.
- Cliente usa IDs estables para turno, dealer, SB, BB y cambio de cartas.
- Eliminados permanecen visibles como OUT sin desordenar los indicadores.
- Reconexión usa token de sesión además del nombre.
- Nombres conectados duplicados se rechazan.
- Ban registra nombre y token de sesión.
- Revive sin votación es inmediato; al expirar una votación se respeta una mayoría ya conseguida.

## UI
- Avatares reducidos y normalizados dentro de sus círculos.
- Se conserva el avatar al ingresar por link/código directo.
- Audio trasladado a `Configuración`.
- Música y efectos vienen activos por defecto; la música arranca en la primera interacción permitida por el navegador.
- Preferencias de audio se guardan en `localStorage`.

## Pruebas incluidas
- `test_v6.js`: dealer, BB, heads-up, short all-ins, side pots y casos extremos de cambio.
- `test_v6_async.js`: auto-runout all-in y Clásico all-in.
- `fuzz_v6.js`: estrés aleatorio Texas/Clásico, 2 a 7 jugadores, múltiples manos, conservación de fichas y cartas únicas.

Para ejecutar luego de `npm install`:

```bash
npm test
```
