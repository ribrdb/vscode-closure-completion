declare module 'fs-walker' {
  function Walk(dir:string, filter:{file?:Function,directory?:Function}, func: Function):void;
  namespace Walk {}
  export=Walk;
}