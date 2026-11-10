package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance14 {
Statement stmt; @GetMapping("/recursive") void entry(String q,int n) throws Exception { recursive(q,n); } void recursive(String q,int n) throws Exception { if(n>0) recursive(q,n-1); else stmt.executeQuery(q); }
}
